package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"runtime/debug"
	"slices"
	"sync"
	"time"
)

const (
	maxConsecutiveFailures = 5
	healthyServiceDuration = 60 * time.Second
)

type ServiceSpec struct {
	PluginID         string
	Dir              string
	Command          string
	Args             []string
	ProtocolVersion  int
	RCISessionSocket string
	Builtin          bool
	Enabled          bool
	RemovalPending   bool
}

type lifecycleToken struct {
	run *operationRun
}

type lifecycleOperation struct {
	token              *lifecycleToken
	joined             bool
	conflict           bool
	supersededWorkDone <-chan struct{}
}

type transitionSnapshot struct {
	present    bool
	intent     Intent
	operation  Operation
	generation uint64
}

func (s ServiceSpec) Equal(other ServiceSpec) bool {
	return s.PluginID == other.PluginID &&
		s.Dir == other.Dir &&
		s.Command == other.Command &&
		slices.Equal(s.Args, other.Args) &&
		s.ProtocolVersion == other.ProtocolVersion &&
		s.RCISessionSocket == other.RCISessionSocket &&
		s.Builtin == other.Builtin &&
		s.Enabled == other.Enabled &&
		s.RemovalPending == other.RemovalPending
}

type SupervisorConfig struct {
	RuntimeRoot               string
	PluginDataRoot            string
	AllowSymlinkedBuiltinRoot bool
	Limits                    Limits
	SupportedProtocols        []int
	ReadinessTimeout          time.Duration
	DiagnosticsTimeout        time.Duration
	StopTimeout               time.Duration
	FinalReapTimeout          time.Duration
	Logger                    *slog.Logger
	Now                       func() time.Time
	LifetimeCtx               context.Context
}

type Supervisor struct {
	mu               sync.Mutex
	cfg              SupervisorConfig
	admission        *Admission
	reservedServices int
	plugins          map[string]*pluginRecord
	nextGen          uint64
	lifetimeCtx      context.Context
	now              func() time.Time
	startDesired     func(ServiceSpec)
	// retryCallbackDone synchronizes tests with retry timer callback completion.
	retryCallbackDone func(string)
	startupWG         sync.WaitGroup
	shuttingDown      bool
}

type pluginRecord struct {
	desired        *ServiceSpec
	servicePresent bool
	serviceSpec    ServiceSpec
	paths          RuntimePaths
	status         RuntimeStatus
	recentStderr   *StderrRing

	transitionPresent bool
	intent            Intent
	operation         Operation
	priorIntent       Intent
	run               *operationRun
	phaseSince        time.Time

	serviceHeld        bool
	reservationPending bool
	command            *exec.Cmd
	done               *processExit
	stopping           bool
	stopDone           chan struct{}
	stopErr            error
	releaseOnStop      bool
	startupQueued      bool
	startupSeq         uint64
	retryTimer         *time.Timer
}

func normalizeSupervisorConfig(cfg SupervisorConfig) SupervisorConfig {
	defaults := DefaultLimits()

	if cfg.Limits.MaxConcurrentExecTotal <= 0 {
		cfg.Limits.MaxConcurrentExecTotal = defaults.MaxConcurrentExecTotal
	}

	if cfg.Limits.MaxConcurrentExecPerPlugin <= 0 {
		cfg.Limits.MaxConcurrentExecPerPlugin = defaults.MaxConcurrentExecPerPlugin
	}

	if cfg.Limits.MaxSupervisedServices <= 0 {
		cfg.Limits.MaxSupervisedServices = defaults.MaxSupervisedServices
	}

	if cfg.ReadinessTimeout <= 0 {
		cfg.ReadinessTimeout = 30 * time.Second
	}

	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = 10 * time.Second
	}

	if cfg.DiagnosticsTimeout <= 0 {
		cfg.DiagnosticsTimeout = 2 * time.Second
	}

	if cfg.FinalReapTimeout <= 0 {
		cfg.FinalReapTimeout = 2 * time.Second
	}

	if cfg.Now == nil {
		cfg.Now = time.Now
	}

	if cfg.LifetimeCtx == nil {
		cfg.LifetimeCtx = context.Background()
	}

	return cfg
}

func newSupervisor(cfg SupervisorConfig, admission *Admission) *Supervisor {
	cfg = normalizeSupervisorConfig(cfg)

	supervisor := &Supervisor{
		cfg:         cfg,
		admission:   admission,
		plugins:     make(map[string]*pluginRecord),
		lifetimeCtx: cfg.LifetimeCtx,
		now:         cfg.Now,
	}

	if supervisor.lifetimeCtx.Done() != nil {
		context.AfterFunc(supervisor.lifetimeCtx, func() {
			supervisor.mu.Lock()

			supervisor.shuttingDown = true

			supervisor.clearDesiredLocked()

			supervisor.stopRetryTimersLocked()
			supervisor.mu.Unlock()
		})
	}

	return supervisor
}

func (s *Supervisor) ensurePluginRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil {
		record = &pluginRecord{}
		s.plugins[pluginID] = record
	}

	return record
}

func (s *Supervisor) serviceRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil || !record.servicePresent {
		return nil
	}

	return record
}

func (s *Supervisor) transitionRecordLocked(pluginID string) *pluginRecord {
	record := s.plugins[pluginID]

	if record == nil || !record.transitionPresent {
		return nil
	}

	return record
}

func (s *Supervisor) ensureTransitionRecordLocked(pluginID string) *pluginRecord {
	record := s.ensurePluginRecordLocked(pluginID)
	record.transitionPresent = true

	return record
}

func (s *Supervisor) ensureServiceRecordLocked(pluginID string) *pluginRecord {
	record := s.ensurePluginRecordLocked(pluginID)

	if !record.servicePresent {
		record.servicePresent = true
		record.status = RuntimeStatus{State: StateStopped}
	}

	return record
}

func (s *Supervisor) acquireServiceSlotLocked(record *pluginRecord) bool {
	if record.serviceHeld {
		return true
	}

	if s.reservedServices >= s.cfg.Limits.MaxSupervisedServices {
		return false
	}

	record.serviceHeld = true
	s.reservedServices++

	return true
}

func (s *Supervisor) releaseServiceSlotLocked(record *pluginRecord) bool {
	if !record.serviceHeld {
		return false
	}

	record.serviceHeld = false
	s.reservedServices--

	return true
}

func (s *Supervisor) reservedServiceCount() int {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.reservedServices
}

func (s *Supervisor) setDesiredLocked(pluginID string, desired *ServiceSpec) {
	if desired == nil {
		if record := s.plugins[pluginID]; record != nil {
			record.desired = nil

			s.prunePluginRecordLocked(pluginID)
		}

		return
	}

	record := s.ensurePluginRecordLocked(pluginID)
	desiredCopy := *desired
	record.desired = &desiredCopy
}

func (s *Supervisor) clearDesiredLocked() {
	for pluginID, record := range s.plugins {
		if record.desired != nil {
			record.desired = nil

			s.prunePluginRecordLocked(pluginID)
		}
	}
}

// A union record remains while any desired, service, transition, process, slot, startup, or retry ownership exists.
func (s *Supervisor) prunePluginRecordLocked(pluginID string) {
	record := s.plugins[pluginID]

	if record == nil || record.desired != nil || record.servicePresent || record.transitionPresent || record.run != nil ||
		record.operation != OpNone || record.serviceHeld || record.reservationPending || record.command != nil ||
		record.done != nil || record.stopping || record.stopDone != nil || record.startupQueued || record.retryTimer != nil {
		return
	}

	delete(s.plugins, pluginID)
}

// beginLocked requires Supervisor.mu held.
func (s *Supervisor) beginLocked(name string, op Operation, want Intent) beginOutcome {
	record := s.transitionRecordLocked(name)

	if record != nil && record.operation != OpNone {
		if record.operation == op && traitsOf(op).joinable {
			return beginOutcome{run: record.run, joined: true}
		}

		if traitsOf(op).supersedes && traitsOf(record.operation).supersedable {
			oldRun := record.run
			priorIntent := record.intent

			s.completeSupersededLocked(oldRun)
			oldRun.cancel()

			run := s.newRunLocked(name, op, want)
			record = s.ensureTransitionRecordLocked(name)
			record.intent = want
			record.operation = op
			record.priorIntent = priorIntent
			record.run = run
			record.phaseSince = s.now()

			return beginOutcome{run: run, supersededWorkDone: oldRun.workDone}
		}

		return beginOutcome{conflict: true}
	}

	priorIntent := IntentRemove

	if record != nil {
		priorIntent = record.intent

		if record.intent == IntentRemove && op != OpInstalling && op != OpDeleting {
			return beginOutcome{conflict: true}
		}
	}

	run := s.newRunLocked(name, op, want)
	record = s.ensureTransitionRecordLocked(name)
	record.intent = want
	record.operation = op
	record.priorIntent = priorIntent
	record.run = run
	record.phaseSince = s.now()

	return beginOutcome{run: run}
}

// isCurrentLocked requires Supervisor.mu held.
func (s *Supervisor) isCurrentLocked(run *operationRun) bool {
	if run == nil || run.completed {
		return false
	}

	record := s.transitionRecordLocked(run.name)

	return record != nil && record.run == run && record.operation == run.op
}

// commitLocked requires Supervisor.mu held.
func (s *Supervisor) commitLocked(run *operationRun) {
	if run == nil {
		return
	}

	if run.targetIntent == IntentRemove {
		if !s.isCurrentLocked(run) {
			return
		}

		s.nextGen++
	}

	s.terminalizeLocked(run, run.targetIntent, nil)
}

// failRestoreLocked requires Supervisor.mu held.
func (s *Supervisor) failRestoreLocked(run *operationRun, err error) {
	if run == nil {
		return
	}

	record := s.transitionRecordLocked(run.name)

	if record == nil {
		return
	}

	s.terminalizeLocked(run, record.priorIntent, err)
}

// failKeepLocked requires Supervisor.mu held.
func (s *Supervisor) failKeepLocked(run *operationRun, err error) {
	if run == nil {
		return
	}

	s.terminalizeLocked(run, run.targetIntent, err)
}

// failLocked requires Supervisor.mu held.
func (s *Supervisor) failLocked(run *operationRun, err error) {
	if run == nil {
		return
	}

	if traitsOf(run.op).restoreOnFail {
		s.failRestoreLocked(run, err)

		return
	}

	s.failKeepLocked(run, err)
}

// forceStopLocked requires Supervisor.mu held.
func (s *Supervisor) forceStopLocked(run *operationRun, err error) {
	s.terminalizeLocked(run, IntentStop, err)
}

func (s *Supervisor) newRunLocked(name string, op Operation, want Intent) *operationRun {
	s.nextGen++
	ctx, cancel := context.WithCancel(s.lifetimeCtx)

	return &operationRun{
		name:         name,
		generation:   s.nextGen,
		op:           op,
		targetIntent: want,
		ctx:          ctx,
		done:         make(chan struct{}),
		workDone:     make(chan struct{}),
		cancel:       cancel,
	}
}

func (s *Supervisor) terminalizeLocked(run *operationRun, intent Intent, err error) {
	if !s.isCurrentLocked(run) {
		return
	}

	record := s.transitionRecordLocked(run.name)
	record.intent = intent
	record.operation = OpNone
	record.phaseSince = s.now()
	run.result = err
	run.completed = true

	run.cancel()
	close(run.done)
}

func (s *Supervisor) completeSupersededLocked(run *operationRun) {
	if run == nil || run.completed {
		return
	}

	run.result = errSuperseded
	run.completed = true

	close(run.done)
}

func (s *Supervisor) beginLifecycle(name string, op Operation, intent Intent) beginOutcome {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.beginLocked(name, op, intent)
}

func lifecycleOperationFromOutcome(outcome beginOutcome) lifecycleOperation {
	operation := lifecycleOperation{
		joined:             outcome.joined,
		conflict:           outcome.conflict,
		supersededWorkDone: outcome.supersededWorkDone,
	}

	if outcome.run != nil {
		operation.token = &lifecycleToken{run: outcome.run}
	}

	return operation
}

func (s *Supervisor) beginLifecycleOperation(name string, op Operation, intent Intent) lifecycleOperation {
	return lifecycleOperationFromOutcome(s.beginLifecycle(name, op, intent))
}

func (s *Supervisor) beginDesiredStartupOutcome(spec ServiceSpec) beginOutcome {
	s.mu.Lock()

	defer s.mu.Unlock()

	desired := s.plugins[spec.PluginID]
	transitionRecord := s.transitionRecordLocked(spec.PluginID)

	if s.shuttingDown || s.lifetimeCtx.Err() != nil || desired == nil || desired.desired == nil || !desired.desired.Enabled ||
		!desired.desired.Equal(spec) || transitionRecord == nil || transitionRecord.intent != IntentRun ||
		transitionRecord.operation != OpNone {
		return beginOutcome{conflict: true}
	}

	if service := s.serviceRecordLocked(spec.PluginID); service != nil {
		service.startupQueued = false
	}

	return s.beginLocked(spec.PluginID, OpStarting, IntentRun)
}

func (s *Supervisor) beginDesiredStartup(spec ServiceSpec) lifecycleOperation {
	return lifecycleOperationFromOutcome(s.beginDesiredStartupOutcome(spec))
}

func (s *Supervisor) isLifecycleCurrent(token *lifecycleToken) bool {
	return token != nil && s.isCurrent(token.run)
}

func (s *Supervisor) waitLifecycle(token *lifecycleToken) error {
	if token == nil {
		return nil
	}

	return waitRun(token.run)
}

func (s *Supervisor) startDesiredService(token *lifecycleToken, spec ServiceSpec) error {
	if !s.isLifecycleCurrent(token) {
		return errSuperseded
	}

	return s.startService(token.run, spec)
}

func (s *Supervisor) startServiceForLifecycle(token *lifecycleToken, spec ServiceSpec) error {
	if token == nil {
		return errSuperseded
	}

	return s.startService(token.run, spec)
}

func (s *Supervisor) stopServiceForLifecycle(token *lifecycleToken) error {
	if token == nil {
		return errSuperseded
	}

	return s.stopService(token.run)
}

func (s *Supervisor) markLifecycleServiceReady(token *lifecycleToken, record *pluginRecord) bool {
	return token != nil && s.markServiceReady(token.run, record)
}

func (s *Supervisor) releaseUnstartedReservationForLifecycle(token *lifecycleToken) bool {
	return token != nil && s.releaseUnstartedReservation(token.run)
}

func (s *Supervisor) runLifecycleWork(
	token *lifecycleToken,
	control LifecycleControl,
	work func(context.Context, LifecycleControl) error,
) (err error) {
	if token == nil {
		return errSuperseded
	}

	run := token.run

	defer close(run.workDone)

	defer func() {
		if recovered := recover(); recovered != nil {
			stack := debug.Stack()
			err = fmt.Errorf("%w: %v", errWorkPanic, recovered)

			if s.cfg.Logger != nil {
				s.cfg.Logger.Error("lifecycle work panicked", "plugin", run.name, "operation", run.op, "panic", recovered, "stack", string(stack))
			}
		}
	}()

	return work(run.ctx, control)
}

func (s *Supervisor) finishLifecycle(token *lifecycleToken, op Operation) *LifecycleEvent {
	if token == nil {
		return nil
	}

	run := token.run

	s.mu.Lock()

	defer s.mu.Unlock()

	s.commitLocked(run)

	state := LifecycleStopped
	reason := lifecycleStopReason(op, run.targetIntent)

	if run.targetIntent == IntentRun {
		state = LifecycleStarted
		reason = LifecycleReasonReconciled
	}

	return &LifecycleEvent{Plugin: run.name, State: state, Reason: reason}
}

func (s *Supervisor) failLifecycle(token *lifecycleToken, err error) {
	if token == nil {
		return
	}

	s.mu.Lock()

	defer s.mu.Unlock()

	if errors.Is(err, ErrForceStopTerminal) {
		s.forceStopLocked(token.run, err)

		return
	}

	s.failLocked(token.run, err)
}

func (s *Supervisor) blocksTraffic(pluginID string) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.transitionRecordLocked(pluginID)

	if record == nil {
		return false
	}

	if record.intent == IntentStop || record.intent == IntentRemove {
		return true
	}

	return traitsOf(record.operation).exclusive
}

func (s *Supervisor) transitionStateLocked(pluginID string) transitionSnapshot {
	record := s.transitionRecordLocked(pluginID)

	if record == nil {
		return transitionSnapshot{intent: IntentRemove}
	}

	snapshot := transitionSnapshot{
		present:   true,
		intent:    record.intent,
		operation: record.operation,
	}

	if record.run != nil {
		snapshot.generation = record.run.generation
	}

	return snapshot
}

func (s *Supervisor) trackDesiredStartupLocked(spec ServiceSpec) func() {
	if s.shuttingDown || s.lifetimeCtx.Err() != nil || s.startDesired == nil {
		return nil
	}

	desiredRecord := s.plugins[spec.PluginID]
	serviceRecord := s.serviceRecordLocked(spec.PluginID)
	transitionRecord := s.transitionRecordLocked(spec.PluginID)

	if desiredRecord == nil || desiredRecord.desired == nil || !desiredRecord.desired.Enabled ||
		!desiredRecord.desired.Equal(spec) || serviceRecord == nil || serviceRecord.stopping ||
		serviceRecord.startupQueued || transitionRecord == nil || transitionRecord.intent != IntentRun ||
		transitionRecord.operation != OpNone {
		return nil
	}

	serviceRecord.startupQueued = true
	serviceRecord.startupSeq++
	sequence := serviceRecord.startupSeq
	start := s.startDesired

	s.startupWG.Add(1)

	return func() {
		go func() {
			defer s.startupWG.Done()

			defer s.finishDesiredStartup(spec.PluginID, sequence)

			start(spec)
		}()
	}
}

func (s *Supervisor) launchDesiredStartup(spec ServiceSpec) {
	s.mu.Lock()

	launch := s.trackDesiredStartupLocked(spec)

	s.mu.Unlock()

	if launch != nil {
		launch()
	}
}

func (s *Supervisor) finishDesiredStartup(pluginID string, sequence uint64) {
	s.mu.Lock()

	if record := s.serviceRecordLocked(pluginID); record != nil && record.startupSeq == sequence {
		record.startupQueued = false
	}

	s.mu.Unlock()
}

func (s *Supervisor) isCurrent(run *operationRun) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.isCurrentLocked(run)
}

// StopAll stops every supervised service and removes its runtime evidence.
func (s *Supervisor) StopAll(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	s.shuttingDown = true

	s.clearDesiredLocked()

	s.stopRetryTimersLocked()

	for _, record := range s.plugins {
		if record.transitionPresent && record.run != nil && !record.run.completed {
			record.run.cancel()
		}
	}

	s.mu.Unlock()
	s.startupWG.Wait()

	s.mu.Lock()

	pluginIDs := make([]string, 0, len(s.plugins))

	for pluginID, record := range s.plugins {
		if record.servicePresent {
			pluginIDs = append(pluginIDs, pluginID)
		}
	}

	s.mu.Unlock()
	slices.Sort(pluginIDs)

	stopErrors := make([]error, len(pluginIDs))
	var stops sync.WaitGroup

	for index, pluginID := range pluginIDs {
		stops.Add(1)

		go func(index int, pluginID string) {
			defer stops.Done()

			stopErrors[index] = s.stopRecord(ctx, pluginID)
		}(index, pluginID)
	}

	stops.Wait()

	stopErrors = append(stopErrors, ctx.Err())

	return errors.Join(stopErrors...)
}

func (s *Supervisor) runningPluginIDs() []string {
	s.mu.Lock()

	defer s.mu.Unlock()

	pluginIDs := make([]string, 0, len(s.plugins))

	for pluginID, record := range s.plugins {
		if record.servicePresent {
			pluginIDs = append(pluginIDs, pluginID)
		}
	}

	slices.Sort(pluginIDs)

	return pluginIDs
}

type reconcilePlan struct {
	startIDs  []string
	stopIDs   []string
	removeIDs []string
}

// lessServiceSpec is the supervisor's ordering policy: builtin services first, then by PluginID.
// Both start (Reconcile) and promotion (promoteBlocked) sort by it so they act in one consistent order.
func lessServiceSpec(a, b ServiceSpec) bool {
	if a.Builtin != b.Builtin {
		return a.Builtin
	}

	return a.PluginID < b.PluginID
}

func (s *Supervisor) Reconcile(ctx context.Context, specs []ServiceSpec) reconcilePlan {
	if ctx == nil {
		ctx = context.Background()
	}

	if ctx.Err() != nil {
		return reconcilePlan{}
	}

	ordered := slices.Clone(specs)

	slices.SortStableFunc(ordered, func(left, right ServiceSpec) int {
		if lessServiceSpec(left, right) {
			return -1
		}

		if lessServiceSpec(right, left) {
			return 1
		}

		return 0
	})

	s.mu.Lock()

	defer s.mu.Unlock()

	if ctx.Err() != nil || s.shuttingDown || s.lifetimeCtx.Err() != nil {
		return reconcilePlan{}
	}

	plan := reconcilePlan{}
	authoritative := make(map[string]struct{}, len(ordered))

	for _, spec := range ordered {
		authoritative[spec.PluginID] = struct{}{}
		want := IntentStop

		if spec.RemovalPending {
			want = IntentRemove
		} else if spec.Enabled {
			want = IntentRun
		}

		if want != IntentRun {
			s.stopRetryTimerLocked(spec.PluginID)
		}

		transitionRecord := s.transitionRecordLocked(spec.PluginID)

		if transitionRecord == nil {
			transitionRecord = s.ensureTransitionRecordLocked(spec.PluginID)
			transitionRecord.intent = want
			transitionRecord.operation = OpNone
			transitionRecord.phaseSince = s.now()
		} else if transitionRecord.operation == OpNone && transitionRecord.intent != IntentRemove {
			transitionRecord.intent = want
			transitionRecord.phaseSince = s.now()
		}

		if transitionRecord.operation != OpNone {
			continue
		}

		if transitionRecord.intent == IntentRemove {
			s.setDesiredLocked(spec.PluginID, nil)

			plan.removeIDs = append(plan.removeIDs, spec.PluginID)

			continue
		}

		spec.Enabled = transitionRecord.intent == IntentRun && spec.Enabled

		s.setDesiredLocked(spec.PluginID, &spec)

		service := s.serviceRecordLocked(spec.PluginID)

		if transitionRecord.intent == IntentStop {
			if service != nil && (service.status.State != StateStopped || service.serviceHeld) {
				plan.stopIDs = append(plan.stopIDs, spec.PluginID)
			}

			continue
		}

		if service == nil || service.status.State == StateStopped || service.status.State == StateCapacityBlocked ||
			!service.serviceSpec.Equal(spec) {
			if s.reserveForReconcileLocked(spec) {
				plan.startIDs = append(plan.startIDs, spec.PluginID)
			}
		}
	}

	for pluginID, service := range s.plugins {
		if !service.servicePresent {
			continue
		}

		if _, exists := authoritative[pluginID]; exists {
			continue
		}

		s.setDesiredLocked(pluginID, nil)
		s.stopRetryTimerLocked(pluginID)

		transitionRecord := s.transitionRecordLocked(pluginID)

		if transitionRecord != nil && transitionRecord.operation != OpNone {
			continue
		}

		if transitionRecord == nil {
			transitionRecord = s.ensureTransitionRecordLocked(pluginID)
			transitionRecord.intent = IntentRemove
			transitionRecord.operation = OpNone
			transitionRecord.phaseSince = s.now()
		} else {
			transitionRecord.intent = IntentRemove
			transitionRecord.phaseSince = s.now()
		}

		plan.removeIDs = append(plan.removeIDs, pluginID)
	}

	slices.Sort(plan.stopIDs)
	slices.Sort(plan.removeIDs)

	return plan
}

// reserveForReconcileLocked makes service admission follow the sorted Reconcile order.
// The returned candidate already owns its slot before Runtime launches startup work.
func (s *Supervisor) reserveForReconcileLocked(spec ServiceSpec) bool {
	record := s.serviceRecordLocked(spec.PluginID)

	if record == nil {
		record = s.ensureServiceRecordLocked(spec.PluginID)
		record.serviceSpec = spec
	} else if record.command == nil && (record.status.State == StateStopped || record.status.State == StateCapacityBlocked) {
		// No process is using the old spec, so a pre-launch update can safely
		// replace the record spec without forcing a stop/re-reserve cycle.
		record.serviceSpec = spec
	}

	if record.stopping {
		return false
	}

	compatible := s.supportedProtocol(spec.ProtocolVersion)

	if !compatible {
		if record.status.State == StateCapacityBlocked {
			record.status.State = StateStopped
			record.status.NextAttemptAt = nil
		}

		return true
	}

	if record.serviceHeld {
		if record.status.State == StateCapacityBlocked {
			record.reservationPending = record.command == nil
		}

		return true
	}

	if !s.acquireServiceSlotLocked(record) {
		record.status.State = StateCapacityBlocked
		record.status.NextAttemptAt = nil
		record.status.RequiredProtocol = spec.ProtocolVersion
		record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
		record.status.Compatible = &compatible

		return false
	}

	record.reservationPending = record.status.State == StateStopped || record.status.State == StateCapacityBlocked

	return true
}

type startAction int

const (
	// startNoop means Start should return plan.err without launching a process.
	startNoop startAction = iota
	// startProceed means the record is reserved and marked starting; launch it.
	startProceed
	// startStopIncompatible means an old runtime must be stopped, then the
	// incompatible protocol status re-stamped, before returning plan.err.
	startStopIncompatible
	// startReplace means a live service has a different desired spec and must
	// be stopped before the replacement process is launched.
	startReplace
)

type startPlan struct {
	record *pluginRecord
	action startAction
	err    error
}

func (s *Supervisor) planStartForRun(run *operationRun, spec ServiceSpec, paths RuntimePaths) startPlan {
	s.mu.Lock()

	defer s.mu.Unlock()

	if !s.isCurrentLocked(run) {
		return startPlan{action: startNoop, err: errSuperseded}
	}

	return s.planStartLocked(spec, paths)
}

func (s *Supervisor) planStartLocked(spec ServiceSpec, paths RuntimePaths) startPlan {
	if s.shuttingDown {
		return startPlan{action: startNoop, err: context.Canceled}
	}

	if err := s.lifetimeCtx.Err(); err != nil {
		return startPlan{action: startNoop, err: err}
	}

	s.setDesiredLocked(spec.PluginID, &spec)

	record := s.serviceRecordLocked(spec.PluginID)
	previousSpec := ServiceSpec{}

	if record != nil {
		previousSpec = record.serviceSpec
	}

	if record == nil {
		record = s.ensureServiceRecordLocked(spec.PluginID)
		record.paths = paths
		record.serviceSpec = spec
	} else {
		record.serviceSpec = spec
		record.paths = paths
	}

	record.status.RequiredProtocol = spec.ProtocolVersion
	record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	compatible := s.supportedProtocol(spec.ProtocolVersion)
	record.status.Compatible = &compatible

	if !compatible {
		unsupported := fmt.Errorf("unsupported service protocol %d", spec.ProtocolVersion)

		if record.command != nil || record.serviceHeld {
			return startPlan{record: record, action: startStopIncompatible, err: unsupported}
		}

		return startPlan{record: record, action: startNoop, err: unsupported}
	}

	now := s.now()

	if record.status.State == StateReady || record.status.State == StateStarting {
		if !previousSpec.Equal(spec) {
			return startPlan{record: record, action: startReplace}
		}

		return startPlan{action: startNoop}
	}

	if record.status.State == StateBackoff && record.status.NextAttemptAt != nil && now.Before(*record.status.NextAttemptAt) {
		return startPlan{action: startNoop, err: fmt.Errorf("service is in backoff until %s", record.status.NextAttemptAt.Format(time.RFC3339))}
	}

	record.reservationPending = false

	if !s.acquireServiceSlotLocked(record) {
		record.status.State = StateCapacityBlocked

		return startPlan{action: startNoop, err: ErrServiceCapacityExceeded}
	}

	record.status.State = StateStarting
	record.status.NextAttemptAt = nil

	return startPlan{record: record, action: startProceed}
}

// restampIncompatible re-applies the protocol status fields that stopProcess
// resets, so an updated-but-unsupported service stays represented as stopped
// and incompatible rather than as a bare stopped record.
func (s *Supervisor) restampIncompatible(run *operationRun, spec ServiceSpec) {
	s.mu.Lock()

	defer s.mu.Unlock()

	if !s.isCurrentLocked(run) {
		return
	}

	record := s.serviceRecordLocked(spec.PluginID)

	if record == nil {
		return
	}

	record.status.RequiredProtocol = spec.ProtocolVersion
	record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	compatible := s.supportedProtocol(spec.ProtocolVersion)
	record.status.Compatible = &compatible
}

func (s *Supervisor) startService(run *operationRun, spec ServiceSpec) error {
	if err := run.ctx.Err(); err != nil {
		return err
	}

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if !spec.Enabled {
		return nil
	}

	paths, err := NewRuntimePaths(s.cfg.RuntimeRoot, spec.PluginID)
	if err != nil {
		return err
	}

	plan := s.planStartForRun(run, spec, paths)

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if err := run.ctx.Err(); err != nil {
		return err
	}

	switch plan.action {
	case startStopIncompatible:
		// An updated service may already own a slot. Stop that old process,
		// then leave the incompatible manifest represented as stopped without
		// exposing a listener or scheduling retries for the unsupported version.
		_ = s.stopProcess(run.ctx, spec.PluginID, true)

		s.restampIncompatible(run, spec)

		return plan.err
	case startReplace:
		if err := s.stopProcess(run.ctx, spec.PluginID, true); err != nil {
			return err
		}

		if !s.isCurrent(run) {
			return errSuperseded
		}

		plan = s.planStartForRun(run, spec, paths)

		if plan.action != startProceed {
			return plan.err
		}
	case startNoop:
		return plan.err
	}

	record := plan.record

	validated, err := s.prepareStart(paths, spec)
	if err != nil {
		s.failStart(run, spec.PluginID, err)

		return err
	}

	if !s.isCurrent(run) {
		return errSuperseded
	}

	if err := run.ctx.Err(); err != nil {
		return err
	}

	command, stderr, err := s.launchService(spec, paths, validated)
	if err != nil {
		s.failStart(run, spec.PluginID, err)

		return err
	}

	done := newProcessExit()

	go func() {
		done.err = command.Wait()

		close(done.done)
	}()

	if !s.registerServiceProcess(run, record, spec.PluginID, paths, command, stderr, done) {
		s.reapUnregisteredProcess(command, done)

		return errSuperseded
	}

	if err := s.probeServiceReadiness(run.ctx, paths, spec); err != nil {
		_ = s.stopProcess(run.ctx, spec.PluginID, false)

		s.failStart(run, spec.PluginID, err)

		return err
	}

	if !s.markServiceReady(run, record) {
		_ = s.stopProcess(run.ctx, spec.PluginID, false)

		return errSuperseded
	}

	go s.observeExit(spec.PluginID, done)

	return nil
}

func (s *Supervisor) registerServiceProcess(
	run *operationRun,
	record *pluginRecord,
	pluginID string,
	paths RuntimePaths,
	command *exec.Cmd,
	stderr *StderrRing,
	done *processExit,
) bool {
	s.mu.Lock()

	registered := s.isCurrentLocked(run)

	if registered {
		record.command = command
		record.done = done
		record.recentStderr = stderr
	}

	s.mu.Unlock()

	if !registered {
		return false
	}

	if err := writeProcessLease(paths.ServiceLease, command.Process.Pid); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("service lease unavailable", "plugin", pluginID, "error", err)
	}

	return true
}

func (s *Supervisor) probeServiceReadiness(ctx context.Context, paths RuntimePaths, spec ServiceSpec) error {
	readinessCtx, cancel := context.WithTimeout(ctx, s.cfg.ReadinessTimeout)

	defer cancel()

	err := ProbeReadiness(readinessCtx, paths.BackendSocket, spec.PluginID, spec.ProtocolVersion, s.cfg.ReadinessTimeout)

	return err
}

func (s *Supervisor) markServiceReady(run *operationRun, record *pluginRecord) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	if !s.isCurrentLocked(run) {
		return false
	}

	record.status.State = StateReady
	record.status.StartedAt = ptrTime(s.now())
	record.status.NextAttemptAt = nil

	return true
}

func (s *Supervisor) stopService(run *operationRun) error {
	if !s.isCurrent(run) {
		return errSuperseded
	}

	stopCtx, cancel := context.WithTimeout(run.ctx, s.cfg.StopTimeout)

	defer cancel()

	return s.stopRecord(stopCtx, run.name)
}

func (s *Supervisor) Status(pluginID string) RuntimeStatus {
	s.mu.Lock()

	if record := s.serviceRecordLocked(pluginID); record != nil {
		status := record.status
		recentStderr := record.recentStderr

		s.mu.Unlock()

		if recentStderr != nil {
			status.RecentStderr = redactStderrLines(recentStderr.Lines())
		}

		return status
	}

	s.mu.Unlock()

	return RuntimeStatus{State: StateStopped}
}

func (s *Supervisor) SocketPath(pluginID string) (string, bool) {
	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil {
		s.mu.Unlock()

		return "", false
	}

	socketPath := record.paths.BackendSocket

	s.mu.Unlock()

	return socketPath, true
}

func (s *Supervisor) supportedProtocol(protocol int) bool {
	return supportsProtocol(protocol, s.cfg.SupportedProtocols)
}

func supportsProtocol(required int, supported []int) bool {
	return slices.Contains(supported, required) || (len(supported) == 0 && required == 1)
}

// SupportsProtocol reports exact membership in daemon-supported protocol versions.
func (s *Supervisor) SupportsProtocol(protocol int) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.supportedProtocol(protocol)
}

func (s *Supervisor) SupportedProtocols() []int {
	s.mu.Lock()

	defer s.mu.Unlock()

	return append([]int{}, s.cfg.SupportedProtocols...)
}

func (s *Supervisor) failStart(run *operationRun, pluginID string, err error) {
	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil || !s.isCurrentLocked(run) {
		return
	}

	s.transitionFailureLocked(record, pluginID, "start failed", err)
}

func (s *Supervisor) observeExit(pluginID string, done *processExit) {
	err := done.wait()

	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil || record.stopping || record.done != done {
		return
	}

	record.command = nil
	record.done = nil

	if record.status.State == StateStopped {
		return
	}

	healthy := record.status.StartedAt != nil && s.now().Sub(*record.status.StartedAt) >= healthyServiceDuration

	if healthy {
		record.status.ConsecutiveFailures = 0
	}

	s.transitionFailureLocked(record, pluginID, "exited", err)
}

// recordFailure advances status into backoff or, past the retry cutoff, failed.
// It is deterministic over status plus the injected now and reports whether
// the caller should schedule a retry and after what delay.
func recordFailure(status *RuntimeStatus, now time.Time, lastExit string, err error) (time.Duration, bool) {
	status.ConsecutiveFailures++
	status.LastExit = lastExit

	if err != nil {
		status.LastError = err.Error()
	}

	if status.ConsecutiveFailures >= maxConsecutiveFailures {
		status.State = StateFailed
		status.NextAttemptAt = nil

		return 0, false
	}

	delay := time.Second << (status.ConsecutiveFailures - 1)
	next := now.Add(delay)
	status.State = StateBackoff
	status.NextAttemptAt = &next

	return delay, true
}

func (s *Supervisor) transitionFailureLocked(record *pluginRecord, pluginID, lastExit string, err error) {
	delay, retry := recordFailure(&record.status, s.now(), lastExit, err)

	if retry {
		s.scheduleRetry(pluginID, delay)
	} else {
		s.stopRetryTimerLocked(pluginID)
	}
}

func (s *Supervisor) stopRetryTimerLocked(pluginID string) {
	record := s.plugins[pluginID]

	if record == nil || record.retryTimer == nil {
		return
	}

	record.retryTimer.Stop()

	record.retryTimer = nil

	s.prunePluginRecordLocked(pluginID)
}

func (s *Supervisor) stopRetryTimersLocked() {
	for pluginID, record := range s.plugins {
		if record.retryTimer != nil {
			s.stopRetryTimerLocked(pluginID)
		}
	}
}

func (s *Supervisor) scheduleRetry(pluginID string, delay time.Duration) {
	s.stopRetryTimerLocked(pluginID)

	if s.shuttingDown || s.lifetimeCtx.Err() != nil {
		return
	}

	record := s.ensurePluginRecordLocked(pluginID)

	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		if callbackDone := s.retryCallbackDone; callbackDone != nil {
			defer callbackDone(pluginID)
		}

		s.mu.Lock()

		if s.plugins[pluginID] != record || record.retryTimer != timer {
			s.mu.Unlock()

			return
		}

		record.retryTimer = nil

		s.prunePluginRecordLocked(pluginID)

		plugin := s.plugins[pluginID]
		service := s.serviceRecordLocked(pluginID)
		transitionRecord := s.transitionRecordLocked(pluginID)

		eligible := plugin != nil && plugin.desired != nil && plugin.desired.Enabled && service != nil &&
			service.status.State == StateBackoff && transitionRecord != nil && transitionRecord.operation == OpNone &&
			transitionRecord.intent == IntentRun

		var launch func()

		if eligible {
			launch = s.trackDesiredStartupLocked(*plugin.desired)
		}

		s.mu.Unlock()

		if launch != nil {
			launch()
		}
	})
	record.retryTimer = timer
}

func (s *Supervisor) stopRecord(ctx context.Context, pluginID string) error {
	return s.stopProcess(ctx, pluginID, true)
}

func (s *Supervisor) releaseUnstartedReservation(run *operationRun) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.takeUnstartedReservationLocked(run)
}

func (s *Supervisor) takeUnstartedReservationLocked(run *operationRun) bool {
	if !s.isCurrentLocked(run) {
		return false
	}

	record := s.serviceRecordLocked(run.name)

	if record == nil || record.command != nil || !record.reservationPending || !record.serviceHeld {
		return false
	}

	s.releaseServiceSlotLocked(record)

	record.reservationPending = false

	if record.status.State == StateCapacityBlocked {
		record.status.State = StateStopped
		record.status.NextAttemptAt = nil
	}

	return true
}

func (s *Supervisor) stopProcess(ctx context.Context, pluginID string, releaseReservation bool) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)

	if record == nil {
		s.mu.Unlock()

		return nil
	}

	if record.stopping {
		if releaseReservation {
			record.releaseOnStop = true
			restartCount := record.status.RestartCount
			record.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}
			record.reservationPending = false
		}

		stopDone := record.stopDone
		stopErr := record.stopErr

		s.mu.Unlock()

		if stopDone == nil {
			return stopErr
		}

		select {
		case <-stopDone:
			s.mu.Lock()

			stopErr := record.stopErr

			s.mu.Unlock()

			return stopErr
		case <-ctx.Done():
			timer := time.NewTimer(s.cfg.FinalReapTimeout)

			defer timer.Stop()

			select {
			case <-stopDone:
				s.mu.Lock()

				stopErr := record.stopErr

				s.mu.Unlock()

				return errors.Join(ctx.Err(), stopErr)
			case <-timer.C:
				return ctx.Err()
			}
		}
	}

	command, done, paths := record.command, record.done, record.paths
	restartCount := record.status.RestartCount
	stopDone := make(chan struct{})
	record.stopping = true
	record.stopDone = stopDone
	record.stopErr = nil
	record.releaseOnStop = releaseReservation
	record.command = nil
	record.done = nil

	s.stopRetryTimerLocked(pluginID)

	if releaseReservation {
		record.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}
		record.reservationPending = false
	}

	s.mu.Unlock()

	var stopErr error

	if command != nil && done != nil {
		_ = terminateExecProcess(command.Process)
		exited, waitErr := waitForProcessExitContext(ctx, done.done, s.cfg.StopTimeout)

		if waitErr != nil {
			stopErr = errors.Join(stopErr, fmt.Errorf("stop service %q: %w", pluginID, waitErr))
		}

		if !exited {
			_ = killExecProcess(command.Process)
			reaped, reapErr := waitForProcessReap(ctx, done.done, s.cfg.FinalReapTimeout)

			if reapErr != nil {
				stopErr = errors.Join(stopErr, fmt.Errorf("reap service %q: %w", pluginID, reapErr))
			}

			if !reaped {
				stopErr = errors.Join(stopErr, fmt.Errorf("service %q did not exit after kill", pluginID))

				if s.cfg.Logger != nil {
					s.cfg.Logger.Warn("service did not exit after kill", "plugin", pluginID, "pid", command.Process.Pid)
				}
			}
		}
	}

	if err := removeRuntimeEvidence(paths); err != nil {
		stopErr = errors.Join(stopErr, err)
	}

	s.mu.Lock()

	releaseOnStop := record.releaseOnStop

	if releaseOnStop {
		s.releaseServiceSlotLocked(record)

		record.reservationPending = false
	}

	record.releaseOnStop = false
	record.stopping = false
	record.stopErr = stopErr
	record.stopDone = nil

	close(stopDone)

	s.mu.Unlock()

	if releaseOnStop {
		s.promoteBlocked()
	}

	return stopErr
}

func (s *Supervisor) promoteBlocked() {
	s.mu.Lock()

	if s.shuttingDown || s.lifetimeCtx.Err() != nil || s.startDesired == nil {
		s.mu.Unlock()

		return
	}

	blocked := make([]ServiceSpec, 0)

	for pluginID, plugin := range s.plugins {
		service := s.serviceRecordLocked(pluginID)

		if plugin.desired != nil && service != nil && service.status.State == StateCapacityBlocked && plugin.desired.Enabled {
			blocked = append(blocked, *plugin.desired)
		}
	}

	slices.SortStableFunc(blocked, func(left, right ServiceSpec) int {
		if lessServiceSpec(left, right) {
			return -1
		}

		if lessServiceSpec(right, left) {
			return 1
		}

		return 0
	})

	launches := make([]func(), 0, len(blocked))

	for _, spec := range blocked {
		plugin := s.plugins[spec.PluginID]
		record := s.serviceRecordLocked(spec.PluginID)
		transitionRecord := s.transitionRecordLocked(spec.PluginID)

		if plugin == nil || plugin.desired == nil || !plugin.desired.Equal(spec) || record == nil || record.serviceHeld ||
			record.status.State != StateCapacityBlocked || transitionRecord == nil ||
			transitionRecord.operation != OpNone || transitionRecord.intent != IntentRun {
			continue
		}

		if s.reserveForReconcileLocked(spec) {
			if launch := s.trackDesiredStartupLocked(spec); launch != nil {
				launches = append(launches, launch)
			}
		}
	}

	s.mu.Unlock()

	for _, launch := range launches {
		launch()
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
