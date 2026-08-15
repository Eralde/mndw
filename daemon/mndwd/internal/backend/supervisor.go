package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
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
}

type SupervisorConfig struct {
	RuntimeRoot        string
	PluginDataRoot     string
	Limits             Limits
	SupportedProtocols []int
	ReadinessTimeout   time.Duration
	DiagnosticsTimeout time.Duration
	StopTimeout        time.Duration
	FinalReapTimeout   time.Duration
	Logger             *slog.Logger
	Now                func() time.Time
}

type Supervisor struct {
	mu        sync.Mutex
	cfg       SupervisorConfig
	admission *Admission
	services  map[string]*serviceRecord
	desired   map[string]ServiceSpec
}

type serviceRecord struct {
	spec        ServiceSpec
	paths       RuntimePaths
	status      RuntimeStatus
	reservation *Reservation
	command     *exec.Cmd
	done        chan error
	stderr      *StderrRing
}

func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	cfg = normalizeSupervisorConfig(cfg)

	return newSupervisor(cfg, NewAdmission(cfg.Limits))
}

func normalizeSupervisorConfig(cfg SupervisorConfig) SupervisorConfig {
	if cfg.Limits.MaxSupervisedServices <= 0 {
		cfg.Limits.MaxSupervisedServices = 8
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
	}
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
		if err := s.Stop(ctx, pluginID); err != nil {
			return err
		}
	}

	return nil
}

func (s *Supervisor) Reconcile(ctx context.Context, specs []ServiceSpec) {
	ordered := append([]ServiceSpec(nil), specs...)

	sort.SliceStable(ordered, func(left, right int) bool {
		if ordered[left].Builtin != ordered[right].Builtin {
			return ordered[left].Builtin
		}

		return ordered[left].PluginID < ordered[right].PluginID
	})

	desired := make(map[string]ServiceSpec, len(ordered))

	for _, spec := range ordered {
		desired[spec.PluginID] = spec
	}

	s.mu.Lock()

	s.desired = desired

	s.mu.Unlock()

	for _, spec := range ordered {
		if !spec.Enabled {
			_ = s.Stop(ctx, spec.PluginID)

			continue
		}

		if err := s.Start(ctx, spec); err != nil && s.cfg.Logger != nil {
			s.cfg.Logger.Warn("service start deferred", "plugin", spec.PluginID, "error", err)
		}
	}

	s.mu.Lock()

	stale := make([]string, 0)

	for pluginID := range s.services {
		if _, exists := desired[pluginID]; !exists {
			stale = append(stale, pluginID)
		}
	}

	s.mu.Unlock()

	for _, pluginID := range stale {
		_ = s.Stop(ctx, pluginID)
	}
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
		s.desired[spec.PluginID] = spec
		record := s.services[spec.PluginID]

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
	})
}

// restampIncompatible re-applies the protocol status fields that stopProcess
// resets, so an updated-but-unsupported service stays represented as stopped
// and incompatible rather than as a bare stopped record.
func (s *Supervisor) restampIncompatible(spec ServiceSpec) {
	s.withLock(func() {
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

func (s *Supervisor) Start(ctx context.Context, spec ServiceSpec) error {
	if !spec.Enabled {
		return nil
	}

	paths, err := NewRuntimePaths(s.cfg.RuntimeRoot, spec.PluginID)
	if err != nil {
		return err
	}

	plan := s.planStart(spec, paths)

	switch plan.action {
	case startStopIncompatible:
		// An updated service may already own a slot. Stop that old process,
		// then leave the incompatible manifest represented as stopped without
		// exposing a listener or scheduling retries for the unsupported version.
		_ = s.stopProcess(ctx, spec.PluginID, true)

		s.restampIncompatible(spec)

		return plan.err
	case startNoop:
		return plan.err
	}

	record := plan.record

	validated, err := s.prepareStart(paths, spec)
	if err != nil {
		s.failStart(spec.PluginID, err)

		return err
	}

	command, stderr, err := s.launchService(spec, paths, validated)
	if err != nil {
		s.failStart(spec.PluginID, err)

		return err
	}

	done := s.registerServiceProcess(record, spec.PluginID, paths, command, stderr)

	go func() { done <- command.Wait() }()

	if err := s.probeServiceReadiness(ctx, paths, spec); err != nil {
		_ = s.stopProcess(ctx, spec.PluginID, false)

		s.failStart(spec.PluginID, err)

		return err
	}

	s.markServiceReady(record)

	go s.observeExit(spec.PluginID, done)

	return nil
}

func (s *Supervisor) prepareStart(paths RuntimePaths, spec ServiceSpec) (ValidatedCommand, error) {
	if err := paths.Ensure(); err != nil {
		return ValidatedCommand{}, err
	}

	if err := recoverStaleRuntime(paths, s.cfg.FinalReapTimeout); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("stale service recovery failed", "plugin", spec.PluginID, "error", err)
	}

	if err := removeRuntimeEvidence(paths); err != nil {
		return ValidatedCommand{}, err
	}

	return ValidateCommand(spec.Dir, spec.Command)
}

func (s *Supervisor) launchService(spec ServiceSpec, paths RuntimePaths, validated ValidatedCommand) (*exec.Cmd, *StderrRing, error) {
	command := exec.Command(validated.Path, spec.Args...)

	configureExecCommand(command)

	command.Dir = spec.Dir
	command.Env = BuildChildEnvironment(EnvironmentSpec{
		Path:             os.Getenv("PATH"),
		PluginID:         spec.PluginID,
		PluginDir:        spec.Dir,
		PluginDataDir:    serviceDataDir(s.cfg.PluginDataRoot, spec),
		PluginRuntimeDir: paths.PluginDir,
		BackendSocket:    paths.BackendSocket,
		ProtocolVersion:  spec.ProtocolVersion,
		RCISessionSocket: spec.RCISessionSocket,
		Service:          true,
	})
	stderr := NewStderrRing(4<<10, 64)
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return nil, nil, err
	}

	return command, stderr, nil
}

func (s *Supervisor) registerServiceProcess(record *serviceRecord, pluginID string, paths RuntimePaths, command *exec.Cmd, stderr *StderrRing) chan error {
	if err := writeProcessLease(paths.ServiceLease, command.Process.Pid); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("service lease unavailable", "plugin", pluginID, "error", err)
	}

	done := make(chan error, 1)

	s.withLock(func() {
		record.command = command
		record.done = done
		record.stderr = stderr
	})

	return done
}

func (s *Supervisor) probeServiceReadiness(ctx context.Context, paths RuntimePaths, spec ServiceSpec) error {
	readinessCtx, cancel := context.WithTimeout(ctx, s.cfg.ReadinessTimeout)
	err := ProbeReadiness(readinessCtx, paths.BackendSocket, spec.PluginID, spec.ProtocolVersion, s.cfg.ReadinessTimeout)

	cancel()

	return err
}

func (s *Supervisor) markServiceReady(record *serviceRecord) {
	s.withLock(func() {
		record.status.State = StateReady
		record.status.StartedAt = ptrTime(s.cfg.Now())
		record.status.NextAttemptAt = nil
	})
}

func serviceDataDir(root string, spec ServiceSpec) string {
	if root == "" {
		return spec.Dir
	}

	path := filepath.Join(root, spec.PluginID)

	if err := os.MkdirAll(path, 0o700); err == nil {
		_ = os.Chmod(path, 0o700)
	}

	return path
}

func (s *Supervisor) Stop(ctx context.Context, pluginID string) error {
	return s.stopRecord(ctx, pluginID)
}

// Forget removes a service from desired state before stopping it. Used by
// disable/delete flows so capacity promotion cannot immediately restart it.
func (s *Supervisor) Forget(ctx context.Context, pluginID string) error {
	s.withLock(func() { delete(s.desired, pluginID) })

	return s.stopRecord(ctx, pluginID)
}

func (s *Supervisor) Restart(ctx context.Context, pluginID string) error {
	s.mu.Lock()

	record := s.services[pluginID]
	var spec ServiceSpec

	if record != nil {
		spec = record.spec
	}

	s.mu.Unlock()

	if record == nil {
		return fmt.Errorf("service %q is not known", pluginID)
	}

	if err := s.stopRecord(ctx, pluginID); err != nil {
		return err
	}

	s.withLock(func() {
		if record.status.RestartCount < 0 {
			record.status.RestartCount = 0
		}

		record.status.RestartCount++
	})

	return s.Start(ctx, spec)
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

func (s *Supervisor) failStart(pluginID string, err error) {
	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.services[pluginID]

	if record == nil {
		return
	}

	s.transitionFailureLocked(record, pluginID, "start failed", err)
}

func (s *Supervisor) observeExit(pluginID string, done <-chan error) {
	err := <-done

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

		if err := s.Start(context.Background(), spec); err != nil && s.cfg.Logger != nil {
			s.cfg.Logger.Warn("service retry deferred", "plugin", pluginID, "error", err)
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

		if !waitForProcessExit(done, s.cfg.StopTimeout) {
			_ = killExecProcess(command.Process)

			if !waitForProcessExit(done, s.cfg.FinalReapTimeout) {
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

func waitForProcessExit(done <-chan error, timeout time.Duration) bool {
	if timeout <= 0 {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}

	timer := time.NewTimer(timeout)

	defer timer.Stop()

	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
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
		if blocked[left].Builtin != blocked[right].Builtin {
			return blocked[left].Builtin
		}

		return blocked[left].PluginID < blocked[right].PluginID
	})

	for _, spec := range blocked {
		_ = s.Start(context.Background(), spec)
	}
}

func removeRuntimeEvidence(paths RuntimePaths) error {
	// The persistent-RCI listener is a daemon-owned facility and intentionally
	// outlives child start, crash, and restart. Its reconciler owns this socket.
	for _, path := range []string{paths.BackendSocket, paths.ServiceLease} {
		if err := removeIfExists(path); err != nil {
			return err
		}
	}

	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return nil
}

func recoverStaleRuntime(paths RuntimePaths, timeout time.Duration) error {
	lease, err := ReadServiceLease(paths.ServiceLease)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil {
		_ = removeIfExists(paths.ServiceLease)

		return err
	}

	matched, err := ValidateServiceLease(lease, systemProcessReader{})
	if err != nil {
		_ = removeRuntimeEvidence(paths)

		return err
	}

	if !matched {
		return removeRuntimeEvidence(paths)
	}

	if err := terminateExecGroup(lease.PGID); err != nil {
		return err
	}

	reapProcessGroup(lease.PGID, timeout)

	return removeRuntimeEvidence(paths)
}

// reapProcessGroup waits up to timeout for the process group to exit, polling
// every 10ms and escalating to SIGKILL once the deadline elapses. A timeout of
// zero or less skips the wait entirely. It does not remove runtime evidence;
// the caller owns that cleanup.
func reapProcessGroup(pgid int, timeout time.Duration) {
	if timeout <= 0 {
		return
	}

	deadline := time.NewTimer(timeout)

	defer deadline.Stop()

	ticker := time.NewTicker(10 * time.Millisecond)

	defer ticker.Stop()

	for processGroupAlive(pgid) {
		select {
		case <-deadline.C:
			_ = killExecGroup(pgid)

			return
		case <-ticker.C:
		}
	}
}

func writeProcessLease(path string, pid int) error {
	reader := systemProcessReader{}
	bootID, err := reader.BootID()
	if err != nil || bootID == "" {
		return err
	}

	identity, err := reader.ProcessIdentity(pid)
	if err != nil {
		return err
	}

	return WriteServiceLease(path, ServiceLease{
		BootID:         bootID,
		PID:            identity.PID,
		PGID:           identity.PGID,
		StartTimeTicks: identity.StartTimeTicks,
		ExecutablePath: identity.ExecutablePath,
		ExecutableDev:  identity.ExecutableDev,
		ExecutableIno:  identity.ExecutableIno,
	})
}

func ptrTime(value time.Time) *time.Time { return &value }
