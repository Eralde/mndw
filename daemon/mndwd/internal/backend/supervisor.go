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
	mu           sync.Mutex
	cfg          SupervisorConfig
	admission    *Admission
	services     map[string]*serviceRecord
	desired      map[string]ServiceSpec
	retryTimers  map[string]*time.Timer
	coord        *coordinator
	startDesired func(ServiceSpec)
	// retryCallbackDone synchronizes tests with retry timer callback completion.
	retryCallbackDone func(string)
	startupWG         sync.WaitGroup
	shuttingDown      bool
}

type serviceRecord struct {
	spec               ServiceSpec
	paths              RuntimePaths
	status             RuntimeStatus
	reservation        *Reservation
	reservationPending bool
	command            *exec.Cmd
	done               *processExit
	stderr             *StderrRing
	stopping           bool
	stopDone           chan struct{}
	stopErr            error
	releaseOnStop      bool
	startupQueued      bool
	startupSeq         uint64
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
		services:    make(map[string]*serviceRecord),
		desired:     make(map[string]ServiceSpec),
		retryTimers: make(map[string]*time.Timer),
		coord:       newCoordinatorWithClock(cfg.LifetimeCtx, cfg.Now),
	}

	if cfg.LifetimeCtx.Done() != nil {
		context.AfterFunc(cfg.LifetimeCtx, func() {
			supervisor.mu.Lock()

			supervisor.shuttingDown = true
			supervisor.desired = make(map[string]ServiceSpec)

			supervisor.stopRetryTimersLocked()
			supervisor.mu.Unlock()
		})
	}

	return supervisor
}

func (s *Supervisor) beginLifecycle(name string, op Operation, intent Intent) beginOutcome {
	return withLockValue(s, func() beginOutcome { return s.coord.begin(name, op, intent) })
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
	return withLockValue(s, func() beginOutcome {
		desired, exists := s.desired[spec.PluginID]
		record := s.coord.records[spec.PluginID]

		if s.shuttingDown || s.coord.lifetimeCtx.Err() != nil || !exists || !desired.Enabled || !desired.Equal(spec) || record == nil ||
			record.intent != IntentRun || record.operation != OpNone {
			return beginOutcome{conflict: true}
		}

		if service := s.services[spec.PluginID]; service != nil {
			service.startupQueued = false
		}

		return s.coord.begin(spec.PluginID, OpStarting, IntentRun)
	})
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

func (s *Supervisor) markLifecycleServiceReady(token *lifecycleToken, record *serviceRecord) bool {
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
	var lifecycleEvent *LifecycleEvent

	s.withLock(func() {
		s.coord.commit(run)

		state := LifecycleStopped
		reason := lifecycleStopReason(op, run.targetIntent)

		if run.targetIntent == IntentRun {
			state = LifecycleStarted
			reason = LifecycleReasonReconciled
		}

		lifecycleEvent = &LifecycleEvent{Plugin: run.name, State: state, Reason: reason}
	})

	return lifecycleEvent
}

func (s *Supervisor) failLifecycle(token *lifecycleToken, err error) {
	if token == nil {
		return
	}

	s.withLock(func() {
		if errors.Is(err, ErrForceStopTerminal) {
			s.coord.forceStop(token.run, err)

			return
		}

		s.coord.fail(token.run, err)
	})
}

func (s *Supervisor) blocksTraffic(pluginID string) bool {
	return withLockValue(s, func() bool {
		record := s.coord.records[pluginID]

		if record == nil {
			return false
		}

		if record.intent == IntentStop || record.intent == IntentRemove {
			return true
		}

		return traitsOf(record.operation).exclusive
	})
}

func (s *Supervisor) transitionStateLocked(pluginID string) transitionSnapshot {
	record := s.coord.records[pluginID]

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
	if s.shuttingDown || s.coord.lifetimeCtx.Err() != nil || s.startDesired == nil {
		return nil
	}

	desired, exists := s.desired[spec.PluginID]
	record := s.services[spec.PluginID]
	transitionRecord := s.coord.records[spec.PluginID]

	if !exists || !desired.Enabled || !desired.Equal(spec) || record == nil || record.stopping ||
		record.startupQueued || transitionRecord == nil || transitionRecord.intent != IntentRun || transitionRecord.operation != OpNone {
		return nil
	}

	record.startupQueued = true
	record.startupSeq++
	sequence := record.startupSeq
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

	if record := s.services[pluginID]; record != nil && record.startupSeq == sequence {
		record.startupQueued = false
	}

	s.mu.Unlock()
}

func (s *Supervisor) isCurrent(run *operationRun) bool {
	return withLockValue(s, func() bool { return s.coord.isCurrent(run) })
}

// withLock runs fn with the supervisor mutex held, guaranteeing release even
// if fn panics. Use it for a single, self-contained critical section.
func (s *Supervisor) withLock(fn func()) {
	s.mu.Lock()

	defer s.mu.Unlock()

	fn()
}

// withLockValue is the value-returning form of withLock. It is a free function
// because Go methods cannot declare their own type parameters.
func withLockValue[T any](s *Supervisor, fn func() T) T {
	s.mu.Lock()

	defer s.mu.Unlock()

	return fn()
}

// StopAll stops every supervised service and removes its runtime evidence.
func (s *Supervisor) StopAll(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	s.shuttingDown = true
	s.desired = make(map[string]ServiceSpec)

	s.stopRetryTimersLocked()

	for _, transitionRecord := range s.coord.records {
		if transitionRecord.run != nil && !transitionRecord.run.completed {
			transitionRecord.run.cancel()
		}
	}

	s.mu.Unlock()
	s.startupWG.Wait()

	s.mu.Lock()

	pluginIDs := make([]string, 0, len(s.services))

	for pluginID := range s.services {
		pluginIDs = append(pluginIDs, pluginID)
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

	pluginIDs := make([]string, 0, len(s.services))

	for pluginID := range s.services {
		pluginIDs = append(pluginIDs, pluginID)
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

	if ctx.Err() != nil || s.shuttingDown || s.coord.lifetimeCtx.Err() != nil {
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

		transitionRecord := s.coord.records[spec.PluginID]

		if transitionRecord == nil {
			transitionRecord = &transition{intent: want, operation: OpNone, phaseSince: s.cfg.Now()}
			s.coord.records[spec.PluginID] = transitionRecord
		} else if transitionRecord.operation == OpNone && transitionRecord.intent != IntentRemove {
			transitionRecord.intent = want
			transitionRecord.phaseSince = s.cfg.Now()
		}

		if transitionRecord.operation != OpNone {
			continue
		}

		if transitionRecord.intent == IntentRemove {
			delete(s.desired, spec.PluginID)

			plan.removeIDs = append(plan.removeIDs, spec.PluginID)

			continue
		}

		spec.Enabled = transitionRecord.intent == IntentRun && spec.Enabled
		s.desired[spec.PluginID] = spec
		service := s.services[spec.PluginID]

		if transitionRecord.intent == IntentStop {
			if service != nil && (service.status.State != StateStopped || service.reservation != nil) {
				plan.stopIDs = append(plan.stopIDs, spec.PluginID)
			}

			continue
		}

		if service == nil || service.status.State == StateStopped || service.status.State == StateCapacityBlocked || !service.spec.Equal(spec) {
			if s.reserveForReconcileLocked(spec) {
				plan.startIDs = append(plan.startIDs, spec.PluginID)
			}
		}
	}

	for pluginID := range s.services {
		if _, exists := authoritative[pluginID]; exists {
			continue
		}

		delete(s.desired, pluginID)
		s.stopRetryTimerLocked(pluginID)

		transitionRecord := s.coord.records[pluginID]

		if transitionRecord != nil && transitionRecord.operation != OpNone {
			continue
		}

		if transitionRecord == nil {
			s.coord.records[pluginID] = &transition{intent: IntentRemove, operation: OpNone, phaseSince: s.cfg.Now()}
		} else {
			transitionRecord.intent = IntentRemove
			transitionRecord.phaseSince = s.cfg.Now()
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
	record := s.services[spec.PluginID]

	if record == nil {
		record = &serviceRecord{spec: spec, status: RuntimeStatus{State: StateStopped}}
		s.services[spec.PluginID] = record
	} else if record.command == nil && (record.status.State == StateStopped || record.status.State == StateCapacityBlocked) {
		// No process is using the old spec, so a pre-launch update can safely
		// replace the record spec without forcing a stop/re-reserve cycle.
		record.spec = spec
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

	if record.reservation != nil {
		if record.status.State == StateCapacityBlocked {
			record.reservationPending = record.command == nil
		}

		return true
	}

	reservation, admitted := s.admission.TryReserveService(spec.PluginID)

	if !admitted {
		record.status.State = StateCapacityBlocked
		record.status.NextAttemptAt = nil
		record.status.RequiredProtocol = spec.ProtocolVersion
		record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
		record.status.Compatible = &compatible

		return false
	}

	record.reservation = reservation
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
	record *serviceRecord
	action startAction
	err    error
}

func (s *Supervisor) planStartForRun(run *operationRun, spec ServiceSpec, paths RuntimePaths) startPlan {
	return withLockValue(s, func() startPlan {
		if !s.coord.isCurrent(run) {
			return startPlan{action: startNoop, err: errSuperseded}
		}

		return s.planStartLocked(spec, paths)
	})
}

func (s *Supervisor) planStartLocked(spec ServiceSpec, paths RuntimePaths) startPlan {
	if s.shuttingDown {
		return startPlan{action: startNoop, err: context.Canceled}
	}

	if err := s.coord.lifetimeCtx.Err(); err != nil {
		return startPlan{action: startNoop, err: err}
	}

	s.desired[spec.PluginID] = spec
	record := s.services[spec.PluginID]
	previousSpec := ServiceSpec{}

	if record != nil {
		previousSpec = record.spec
	}

	if record == nil {
		record = &serviceRecord{spec: spec, paths: paths, status: RuntimeStatus{State: StateStopped}}
		s.services[spec.PluginID] = record
	} else {
		record.spec = spec
		record.paths = paths
	}

	record.status.RequiredProtocol = spec.ProtocolVersion
	record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
	compatible := s.supportedProtocol(spec.ProtocolVersion)
	record.status.Compatible = &compatible

	if !compatible {
		unsupported := fmt.Errorf("unsupported service protocol %d", spec.ProtocolVersion)

		if record.command != nil || record.reservation != nil {
			return startPlan{record: record, action: startStopIncompatible, err: unsupported}
		}

		return startPlan{record: record, action: startNoop, err: unsupported}
	}

	now := s.cfg.Now()

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

	if record.reservation == nil {
		reservation, admitted := s.admission.TryReserveService(spec.PluginID)

		if !admitted {
			record.status.State = StateCapacityBlocked

			return startPlan{action: startNoop, err: ErrServiceCapacityExceeded}
		}

		record.reservation = reservation
	}

	record.status.State = StateStarting
	record.status.NextAttemptAt = nil

	return startPlan{record: record, action: startProceed}
}

// restampIncompatible re-applies the protocol status fields that stopProcess
// resets, so an updated-but-unsupported service stays represented as stopped
// and incompatible rather than as a bare stopped record.
func (s *Supervisor) restampIncompatible(run *operationRun, spec ServiceSpec) {
	s.withLock(func() {
		if !s.coord.isCurrent(run) {
			return
		}

		record := s.services[spec.PluginID]

		if record == nil {
			return
		}

		record.status.RequiredProtocol = spec.ProtocolVersion
		record.status.SupportedProtocols = slices.Clone(s.cfg.SupportedProtocols)
		compatible := s.supportedProtocol(spec.ProtocolVersion)
		record.status.Compatible = &compatible
	})
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
	record *serviceRecord,
	pluginID string,
	paths RuntimePaths,
	command *exec.Cmd,
	stderr *StderrRing,
	done *processExit,
) bool {
	registered := withLockValue(s, func() bool {
		if !s.coord.isCurrent(run) {
			return false
		}

		record.command = command
		record.done = done
		record.stderr = stderr

		return true
	})

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

func (s *Supervisor) markServiceReady(run *operationRun, record *serviceRecord) bool {
	return withLockValue(s, func() bool {
		if !s.coord.isCurrent(run) {
			return false
		}

		record.status.State = StateReady
		record.status.StartedAt = ptrTime(s.cfg.Now())
		record.status.NextAttemptAt = nil

		return true
	})
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

	defer s.mu.Unlock()

	if record := s.services[pluginID]; record != nil {
		status := record.status

		if record.stderr != nil {
			status.RecentStderr = redactStderrLines(record.stderr.Lines())
		}

		return status
	}

	return RuntimeStatus{State: StateStopped}
}

func (s *Supervisor) SocketPath(pluginID string) (string, bool) {
	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.services[pluginID]

	if record == nil {
		return "", false
	}

	return record.paths.BackendSocket, true
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

	record := s.services[pluginID]

	if record == nil || !s.coord.isCurrent(run) {
		return
	}

	s.transitionFailureLocked(record, pluginID, "start failed", err)
}

func (s *Supervisor) observeExit(pluginID string, done *processExit) {
	err := done.wait()

	s.withLock(func() {
		record := s.services[pluginID]

		if record == nil || record.stopping || record.done != done {
			return
		}

		record.command = nil
		record.done = nil

		if record.status.State == StateStopped {
			return
		}

		healthy := record.status.StartedAt != nil && s.cfg.Now().Sub(*record.status.StartedAt) >= healthyServiceDuration

		if healthy {
			record.status.ConsecutiveFailures = 0
		}

		s.transitionFailureLocked(record, pluginID, "exited", err)
	})
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

func (s *Supervisor) transitionFailureLocked(record *serviceRecord, pluginID, lastExit string, err error) {
	delay, retry := recordFailure(&record.status, s.cfg.Now(), lastExit, err)

	if retry {
		s.scheduleRetry(pluginID, delay)
	} else {
		s.stopRetryTimerLocked(pluginID)
	}
}

func (s *Supervisor) stopRetryTimerLocked(pluginID string) {
	if timer := s.retryTimers[pluginID]; timer != nil {
		timer.Stop()
		delete(s.retryTimers, pluginID)
	}
}

func (s *Supervisor) stopRetryTimersLocked() {
	for pluginID, timer := range s.retryTimers {
		timer.Stop()
		delete(s.retryTimers, pluginID)
	}
}

func (s *Supervisor) scheduleRetry(pluginID string, delay time.Duration) {
	s.stopRetryTimerLocked(pluginID)

	if s.shuttingDown || s.coord.lifetimeCtx.Err() != nil {
		return
	}

	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		if callbackDone := s.retryCallbackDone; callbackDone != nil {
			defer callbackDone(pluginID)
		}

		s.mu.Lock()

		if s.retryTimers[pluginID] != timer {
			s.mu.Unlock()

			return
		}

		delete(s.retryTimers, pluginID)

		spec, desired := s.desired[pluginID]
		record := s.services[pluginID]
		transitionRecord := s.coord.records[pluginID]
		eligible := desired && spec.Enabled && record != nil && record.status.State == StateBackoff &&
			transitionRecord != nil && transitionRecord.operation == OpNone && transitionRecord.intent == IntentRun

		var launch func()

		if eligible {
			launch = s.trackDesiredStartupLocked(spec)
		}

		s.mu.Unlock()

		if launch != nil {
			launch()
		}
	})
	s.retryTimers[pluginID] = timer
}

func (s *Supervisor) stopRecord(ctx context.Context, pluginID string) error {
	return s.stopProcess(ctx, pluginID, true)
}

func (s *Supervisor) releaseUnstartedReservation(run *operationRun) bool {
	var reservation *Reservation

	s.withLock(func() {
		if !s.coord.isCurrent(run) {
			return
		}

		record := s.services[run.name]

		if record == nil || record.command != nil || !record.reservationPending || record.reservation == nil {
			return
		}

		reservation = record.reservation
		record.reservation = nil
		record.reservationPending = false

		if record.status.State == StateCapacityBlocked {
			record.status.State = StateStopped
			record.status.NextAttemptAt = nil
		}
	})

	if reservation == nil {
		return false
	}

	reservation.Release()

	return true
}

func (s *Supervisor) stopProcess(ctx context.Context, pluginID string, releaseReservation bool) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	record := s.services[pluginID]

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

	command, done, reservation, paths := record.command, record.done, record.reservation, record.paths
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
		record.reservation = nil
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

	if releaseOnStop && reservation != nil {
		reservation.Release()
	}

	if releaseOnStop {
		record.reservation = nil
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

	if s.shuttingDown || s.coord.lifetimeCtx.Err() != nil || s.startDesired == nil {
		s.mu.Unlock()

		return
	}

	blocked := make([]ServiceSpec, 0)

	for pluginID, spec := range s.desired {
		if record := s.services[pluginID]; record != nil && record.status.State == StateCapacityBlocked && spec.Enabled {
			blocked = append(blocked, spec)
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
		desired, exists := s.desired[spec.PluginID]
		record := s.services[spec.PluginID]
		transitionRecord := s.coord.records[spec.PluginID]

		if !exists || !desired.Equal(spec) || record == nil || record.reservation != nil ||
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
