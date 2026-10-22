package backend

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"slices"
	"sort"
	"sync"
	"time"
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
	coord        *coordinator
	startDesired func(ServiceSpec)
}

type serviceRecord struct {
	spec        ServiceSpec
	paths       RuntimePaths
	status      RuntimeStatus
	reservation *Reservation
	command     *exec.Cmd
	done        *processExit
	stderr      *StderrRing
}

func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	cfg = normalizeSupervisorConfig(cfg)

	return newSupervisor(cfg, NewAdmission(cfg.Limits))
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

	return cfg
}

func newSupervisor(cfg SupervisorConfig, admission *Admission) *Supervisor {
	return &Supervisor{
		cfg:       cfg,
		admission: admission,
		services:  make(map[string]*serviceRecord),
		desired:   make(map[string]ServiceSpec),
		coord:     newCoordinator(cfg.LifetimeCtx),
	}
}

func (s *Supervisor) beginLifecycle(name string, op Operation, intent Intent) beginOutcome {
	return withLockValue(s, func() beginOutcome { return s.coord.begin(name, op, intent) })
}

func (s *Supervisor) beginDesiredStartup(spec ServiceSpec) beginOutcome {
	return withLockValue(s, func() beginOutcome {
		desired, exists := s.desired[spec.PluginID]
		record := s.coord.records[spec.PluginID]

		if !exists || !desired.Enabled || !desired.Equal(spec) || record == nil ||
			record.intent != IntentRun || record.operation != OpNone {
			return beginOutcome{conflict: true}
		}

		return s.coord.begin(spec.PluginID, OpStarting, IntentRun)
	})
}

func (s *Supervisor) isCurrent(run *operationRun) bool {
	return withLockValue(s, func() bool { return s.coord.isCurrent(run) })
}

func (s *Supervisor) operationOf(name string) Operation {
	return withLockValue(s, func() Operation {
		record := s.coord.records[name]

		if record == nil {
			return OpNone
		}

		return record.operation
	})
}

func (s *Supervisor) intentOf(name string) Intent {
	return withLockValue(s, func() Intent { return s.coord.intentOf(name) })
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
	s.mu.Lock()

	pluginIDs := make([]string, 0, len(s.services))

	for pluginID := range s.services {
		pluginIDs = append(pluginIDs, pluginID)
	}

	s.desired = make(map[string]ServiceSpec)

	s.mu.Unlock()
	sort.Strings(pluginIDs)

	for _, pluginID := range pluginIDs {
		if err := s.stopRecord(ctx, pluginID); err != nil {
			return err
		}
	}

	return nil
}

func (s *Supervisor) runningPluginIDs() []string {
	s.mu.Lock()

	defer s.mu.Unlock()

	pluginIDs := make([]string, 0, len(s.services))

	for pluginID := range s.services {
		pluginIDs = append(pluginIDs, pluginID)
	}

	sort.Strings(pluginIDs)

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

func (s *Supervisor) Reconcile(_ context.Context, specs []ServiceSpec) reconcilePlan {
	ordered := append([]ServiceSpec(nil), specs...)

	sort.SliceStable(ordered, func(left, right int) bool {
		return lessServiceSpec(ordered[left], ordered[right])
	})

	s.mu.Lock()

	defer s.mu.Unlock()

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
			if service != nil && service.status.State != StateStopped {
				plan.stopIDs = append(plan.stopIDs, spec.PluginID)
			}

			continue
		}

		if service == nil || service.status.State == StateStopped || !service.spec.Equal(spec) {
			plan.startIDs = append(plan.startIDs, spec.PluginID)
		}
	}

	for pluginID := range s.services {
		if _, exists := authoritative[pluginID]; exists {
			continue
		}

		delete(s.desired, pluginID)

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

	sort.Strings(plan.startIDs)
	sort.Strings(plan.stopIDs)
	sort.Strings(plan.removeIDs)

	return plan
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

// planStart applies the start state/admission decision under one held lock and
// performs no process or socket I/O. The caller executes the external side
// effects implied by the returned action.
func (s *Supervisor) planStart(spec ServiceSpec, paths RuntimePaths) startPlan {
	return withLockValue(s, func() startPlan {
		return s.planStartLocked(spec, paths)
	})
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
	record.status.SupportedProtocols = append([]int(nil), s.cfg.SupportedProtocols...)
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
		record.status.SupportedProtocols = append([]int(nil), s.cfg.SupportedProtocols...)
		compatible := s.supportedProtocol(spec.ProtocolVersion)
		record.status.Compatible = &compatible
	})
}

func (s *Supervisor) startService(run *operationRun, spec ServiceSpec) error {
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
	err := ProbeReadiness(readinessCtx, paths.BackendSocket, spec.PluginID, spec.ProtocolVersion, s.cfg.ReadinessTimeout)

	cancel()

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
	for _, candidate := range supported {
		if candidate == required {
			return true
		}
	}

	return len(supported) == 0 && required == 1
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

		if record == nil {
			return
		}

		record.command = nil
		record.done = nil

		if record.status.State == StateStopped {
			return
		}

		healthy := record.status.StartedAt != nil && s.cfg.Now().Sub(*record.status.StartedAt) >= 60*time.Second

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

	if status.ConsecutiveFailures >= 5 {
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
	}
}

func (s *Supervisor) scheduleRetry(pluginID string, delay time.Duration) {
	go func() {
		timer := time.NewTimer(delay)

		defer timer.Stop()

		<-timer.C

		s.mu.Lock()

		spec, desired := s.desired[pluginID]
		record := s.services[pluginID]
		eligible := desired && spec.Enabled && record != nil && record.status.State == StateBackoff

		s.mu.Unlock()

		if !eligible {
			return
		}

		if s.startDesired != nil {
			s.startDesired(spec)
		}
	}()
}

func (s *Supervisor) stopRecord(ctx context.Context, pluginID string) error {
	return s.stopProcess(ctx, pluginID, true)
}

func (s *Supervisor) stopProcess(ctx context.Context, pluginID string, releaseReservation bool) error {
	s.mu.Lock()

	record := s.services[pluginID]

	if record == nil {
		s.mu.Unlock()

		return nil
	}

	command, done, reservation, paths := record.command, record.done, record.reservation, record.paths
	restartCount := record.status.RestartCount

	if releaseReservation {
		record.status = RuntimeStatus{State: StateStopped, RestartCount: restartCount}
	}

	record.command = nil
	record.done = nil

	if releaseReservation {
		record.reservation = nil
	}

	s.mu.Unlock()

	var stopErr error

	if command != nil && done != nil {
		_ = terminateExecProcess(command.Process)

		if !waitForProcessExit(done.done, s.cfg.StopTimeout) {
			_ = killExecProcess(command.Process)

			if !waitForProcessExit(done.done, s.cfg.FinalReapTimeout) {
				stopErr = fmt.Errorf("service %q did not exit after kill", pluginID)
			}
		}
	}

	if releaseReservation && reservation != nil {
		reservation.Release()
	}

	if err := removeRuntimeEvidence(paths); err != nil {
		return err
	}

	if releaseReservation {
		s.promoteBlocked()
	}

	return stopErr
}

func (s *Supervisor) promoteBlocked() {
	s.mu.Lock()

	blocked := make([]ServiceSpec, 0)

	for pluginID, spec := range s.desired {
		if record := s.services[pluginID]; record != nil && record.status.State == StateCapacityBlocked && spec.Enabled {
			blocked = append(blocked, spec)
		}
	}

	s.mu.Unlock()
	sort.SliceStable(blocked, func(left, right int) bool {
		return lessServiceSpec(blocked[left], blocked[right])
	})

	for _, spec := range blocked {
		if s.startDesired != nil {
			s.startDesired(spec)
		}
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
