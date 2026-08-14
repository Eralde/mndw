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

func (s *Supervisor) Start(ctx context.Context, spec ServiceSpec) error {
	if !spec.Enabled {
		return nil
	}

	paths, err := NewRuntimePaths(s.cfg.RuntimeRoot, spec.PluginID)
	if err != nil {
		return err
	}

	s.mu.Lock()

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
		hadRuntime := record.command != nil || record.reservation != nil

		s.mu.Unlock()

		// An updated service may already own a slot. Stop that old process before
		// leaving the incompatible manifest represented as stopped, without
		// exposing a listener or scheduling retries for the unsupported version.
		if hadRuntime {
			_ = s.stopProcess(ctx, spec.PluginID, true)

			s.mu.Lock()

			record = s.services[spec.PluginID]

			if record != nil {
				record.status.RequiredProtocol = spec.ProtocolVersion
				record.status.SupportedProtocols = append([]int(nil), s.cfg.SupportedProtocols...)
				record.status.Compatible = &compatible
			}

			s.mu.Unlock()
		}

		return fmt.Errorf("unsupported service protocol %d", spec.ProtocolVersion)
	}

	now := s.cfg.Now()

	if record.status.State == StateReady || record.status.State == StateStarting {
		s.mu.Unlock()

		return nil
	}

	if record.status.State == StateBackoff && record.status.NextAttemptAt != nil && now.Before(*record.status.NextAttemptAt) {
		s.mu.Unlock()

		return fmt.Errorf("service is in backoff until %s", record.status.NextAttemptAt.Format(time.RFC3339))
	}

	if record.reservation == nil {
		reservation, admitted := s.admission.TryReserveService(spec.PluginID)

		if !admitted {
			record.status.State = StateCapacityBlocked

			s.mu.Unlock()

			return fmt.Errorf("service capacity exceeded")
		}

		record.reservation = reservation
	}

	record.status.State = StateStarting
	record.status.NextAttemptAt = nil

	s.mu.Unlock()

	if err := paths.Ensure(); err != nil {
		s.failStart(spec.PluginID, err)

		return err
	}

	if err := recoverStaleRuntime(paths, s.cfg.FinalReapTimeout); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("stale service recovery failed", "plugin", spec.PluginID, "error", err)
	}

	if err := removeRuntimeEvidence(paths); err != nil {
		s.failStart(spec.PluginID, err)

		return err
	}

	validated, err := ValidateCommand(spec.Dir, spec.Command)
	if err != nil {
		s.failStart(spec.PluginID, err)

		return err
	}

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
		s.failStart(spec.PluginID, err)

		return err
	}

	if err := writeProcessLease(paths.ServiceLease, command.Process.Pid); err != nil && s.cfg.Logger != nil {
		s.cfg.Logger.Warn("service lease unavailable", "plugin", spec.PluginID, "error", err)
	}

	done := make(chan error, 1)

	s.mu.Lock()

	record.command = command
	record.done = done
	record.stderr = stderr

	s.mu.Unlock()

	go func() { done <- command.Wait() }()

	readinessCtx, cancel := context.WithTimeout(ctx, s.cfg.ReadinessTimeout)
	err = ProbeReadiness(readinessCtx, paths.BackendSocket, spec.PluginID, spec.ProtocolVersion, s.cfg.ReadinessTimeout)

	cancel()

	if err != nil {
		_ = s.stopProcess(ctx, spec.PluginID, false)

		s.failStart(spec.PluginID, err)

		return err
	}

	s.mu.Lock()

	record.status.State = StateReady
	record.status.StartedAt = ptrTime(s.cfg.Now())
	record.status.NextAttemptAt = nil

	s.mu.Unlock()

	go s.observeExit(spec.PluginID, done)

	return nil
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
	s.mu.Lock()
	delete(s.desired, pluginID)
	s.mu.Unlock()

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

	s.mu.Lock()

	if record.status.RestartCount < 0 {
		record.status.RestartCount = 0
	}

	record.status.RestartCount++

	s.mu.Unlock()

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

	s.mu.Lock()

	record := s.services[pluginID]

	if record == nil {
		s.mu.Unlock()

		return
	}

	record.command = nil
	record.done = nil

	if record.status.State == StateStopped {
		s.mu.Unlock()

		return
	}

	healthy := record.status.StartedAt != nil && s.cfg.Now().Sub(*record.status.StartedAt) >= 60*time.Second

	if healthy {
		record.status.ConsecutiveFailures = 0
	}

	s.transitionFailureLocked(record, pluginID, "exited", err)
	s.mu.Unlock()
}

func (s *Supervisor) transitionFailureLocked(record *serviceRecord, pluginID, lastExit string, err error) {
	record.status.ConsecutiveFailures++
	record.status.LastExit = lastExit

	if err != nil {
		record.status.LastError = err.Error()
	}

	if record.status.ConsecutiveFailures >= 5 {
		record.status.State = StateFailed
		record.status.NextAttemptAt = nil

		return
	}

	delay := time.Second << (record.status.ConsecutiveFailures - 1)
	next := s.cfg.Now().Add(delay)
	record.status.State = StateBackoff
	record.status.NextAttemptAt = &next

	s.scheduleRetry(pluginID, delay)
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

	if timeout > 0 {
		deadline := time.NewTimer(timeout)
		ticker := time.NewTicker(10 * time.Millisecond)

		for processGroupAlive(lease.PGID) {
			select {
			case <-deadline.C:
				_ = killExecGroup(lease.PGID)

				deadline.Stop()
				ticker.Stop()

				goto reaped
			case <-ticker.C:
			}
		}

		deadline.Stop()
		ticker.Stop()
	}

reaped:
	return removeRuntimeEvidence(paths)
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
