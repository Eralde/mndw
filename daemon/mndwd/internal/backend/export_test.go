package backend

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"testing"
	"time"

	"mndwd/internal/httpx"
)

func init() {
	invariantChecksEnabled = true
}

func markInvariantFixtureForTest(s *Supervisor, pluginID string, ids ...invariantID) {
	record := s.plugins[pluginID]

	if record == nil {
		return
	}

	for _, violation := range s.checkInvariantsLocked() {
		if violation.PluginID != pluginID {
			continue
		}

		if len(ids) > 0 {
			selected := false

			for _, id := range ids {
				if violation.ID == id {
					selected = true

					break
				}
			}

			if !selected {
				continue
			}
		}

		if s.invariantFixtureExempt == nil {
			s.invariantFixtureExempt = make(map[*pluginRecord]map[invariantID]struct{})
		}

		if s.invariantFixtureExempt[record] == nil {
			s.invariantFixtureExempt[record] = make(map[invariantID]struct{})
		}

		s.invariantFixtureExempt[record][violation.ID] = struct{}{}
	}
}

func declareInvariantFixtureForTest(s *Supervisor, pluginID string, id invariantID, reason string) {
	s.mu.Lock()

	if s.invariantDeclaredFixtureExempt == nil {
		s.invariantDeclaredFixtureExempt = make(map[string]map[invariantID]string)
	}

	if s.invariantDeclaredFixtureExempt[pluginID] == nil {
		s.invariantDeclaredFixtureExempt[pluginID] = make(map[invariantID]string)
	}

	s.invariantDeclaredFixtureExempt[pluginID][id] = reason

	s.unlock()
}

type startPlanSnapshot struct {
	action startAction
	err    error
}

type pluginSnapshot struct {
	desiredPresent     bool
	desired            ServiceSpec
	servicePresent     bool
	status             RuntimeStatus
	serviceSlotHeld    bool
	reservationPending bool
	startupQueued      bool
	startupSeq         uint64
	retryTimerPresent  bool
	pendingStart       bool
	processPresent     bool
	processID          uint64
	transitionPresent  bool
	intent             Intent
	operation          Operation
	generation         uint64
}

type serviceRecord struct {
	spec               ServiceSpec
	paths              RuntimePaths
	status             RuntimeStatus
	serviceHeld        bool
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

type transition struct {
	intent      Intent
	operation   Operation
	priorIntent Intent
	run         *operationRun
}

type lifecycleReadinessMarker interface {
	markServiceReady(*pluginRecord) bool
}

func markLifecycleServiceReady(control LifecycleControl, record *pluginRecord) bool {
	marker, ok := control.(lifecycleReadinessMarker)

	return ok && marker.markServiceReady(record)
}

func NewExecRunner(cfg ExecRunnerConfig) *ExecRunner {
	cfg = cfg.withDefaults()

	return newExecRunner(cfg, NewAdmission(Limits{
		MaxConcurrentExecTotal:     cfg.Limits.MaxConcurrentExecTotal,
		MaxConcurrentExecPerPlugin: cfg.Limits.MaxConcurrentExecPerPlugin,
	}))
}

func (r *ExecRunner) Serve(ctx context.Context, request ExecRequest, writer http.ResponseWriter) *httpx.APIError {
	reservation, admitted := r.admission.TryAcquireExec(request.PluginID)

	if !admitted {
		return httpx.NewError(http.StatusTooManyRequests, httpx.CodeBackendBusy, "backend execution capacity is busy")
	}

	defer reservation.Release()

	return r.ServeReserved(ctx, request, writer, reservation)
}

func ownProcessID() int { return os.Getpid() }

func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	if cfg.Logger == nil {
		cfg.Logger = backendTestLogger()
	}

	cfg = cfg.withDefaults()

	return newSupervisor(cfg, NewAdmission(cfg.Limits))
}

func (s *Supervisor) operationOf(name string) Operation {
	return s.pluginSnapshot(name).operation
}

func (s *Supervisor) intentOf(name string) Intent {
	return s.pluginSnapshot(name).intent
}

func (s *Supervisor) planStart(spec ServiceSpec, paths RuntimePaths) startPlanSnapshot {
	s.mu.Lock()

	defer s.unlock()

	plan := s.planStartLocked(spec, paths)

	markInvariantFixtureForTest(s, spec.PluginID, invI14)

	return startPlanSnapshot{action: plan.action, err: plan.err}
}

func (s *Supervisor) pluginSnapshot(name string) pluginSnapshot {
	s.mu.Lock()

	defer s.unlock()

	return s.pluginSnapshotLocked(name)
}

func (s *Supervisor) pluginSnapshotLocked(name string) pluginSnapshot {
	snapshot := pluginSnapshot{intent: IntentRemove}

	if record := s.plugins[name]; record != nil && record.desired != nil {
		snapshot.desiredPresent = true
		snapshot.desired = *record.desired
		snapshot.desired.Args = append([]string(nil), record.desired.Args...)
	}

	if record := s.serviceRecordLocked(name); record != nil {
		snapshot.servicePresent = true
		snapshot.status = cloneRuntimeStatus(record.service.status)
		snapshot.serviceSlotHeld = record.serviceHeld
		snapshot.reservationPending = record.reservationPending
		snapshot.startupQueued = record.startupQueued
		snapshot.startupSeq = record.startupSeq
		snapshot.pendingStart = record.pendingStart
		snapshot.processPresent = record.process != nil

		if record.process != nil {
			snapshot.processID = record.process.id
		}
	}

	transition := s.transitionStateLocked(name)

	if transition.present {
		snapshot.transitionPresent = true
		snapshot.intent = transition.intent
		snapshot.operation = transition.operation
		snapshot.generation = transition.generation
	}

	if record := s.plugins[name]; record != nil {
		snapshot.retryTimerPresent = record.retryTimer != nil
	}

	return snapshot
}

func cloneRuntimeStatus(status RuntimeStatus) RuntimeStatus {
	if status.StartedAt != nil {
		startedAt := *status.StartedAt
		status.StartedAt = &startedAt
	}

	if status.NextAttemptAt != nil {
		nextAttemptAt := *status.NextAttemptAt
		status.NextAttemptAt = &nextAttemptAt
	}

	if status.Compatible != nil {
		compatible := *status.Compatible
		status.Compatible = &compatible
	}

	status.RecentStderr = append([]string(nil), status.RecentStderr...)
	status.SupportedProtocols = append([]int(nil), status.SupportedProtocols...)

	return status
}

func (r *Runtime) operationOf(name string) Operation {
	return r.supervisor.operationOf(name)
}

func (r *Runtime) intentOf(name string) Intent {
	return r.supervisor.intentOf(name)
}

func (r *Runtime) generationOf(name string) uint64 {
	return r.supervisor.pluginSnapshot(name).generation
}

func seedSupervisorStateForTest(
	s *Supervisor,
	pluginID string,
	desired *ServiceSpec,
	service *serviceRecord,
	transition *transition,
) {
	s.mu.Lock()

	defer s.unlock()

	if desired != nil {
		s.setDesiredLocked(pluginID, desired)
	}

	if service != nil {
		setSupervisorServiceRecordLockedForTest(s, pluginID, service)
	}

	if transition != nil {
		setSupervisorTransitionLockedForTest(s, pluginID, transition)
	}
}

func setSupervisorServiceRecordLockedForTest(s *Supervisor, pluginID string, fixture *serviceRecord) *pluginRecord {
	record := s.ensureServiceRecordLocked(pluginID)
	record.service.spec = fixture.spec
	record.service.paths = fixture.paths
	record.service.status = fixture.status

	if fixture.serviceHeld && !record.serviceHeld {
		if !s.acquireServiceSlotLocked(record) {
			panic("test service slot exceeds configured capacity")
		}
	} else if !fixture.serviceHeld && record.serviceHeld {
		record.launch = nil
		record.process = nil
		record.processRegistered = false

		s.releaseServiceSlotLocked(record)
	}

	record.reservationPending = fixture.reservationPending
	record.launch = nil
	record.process = nil
	record.processRegistered = false

	if fixture.done != nil {
		s.nextProcessID++
		record.process = &registeredProcess{
			id:            s.nextProcessID,
			runGeneration: s.transitionGenerationLocked(pluginID),
			command:       fixture.command,
			exit:          fixture.done,
		}
		record.processRegistered = true
	}

	record.service.recentStderr = fixture.stderr
	record.stopping = fixture.stopping
	record.stopDone = fixture.stopDone
	record.stopErr = fixture.stopErr
	record.releaseOnStop = fixture.releaseOnStop
	record.startupQueued = fixture.startupQueued
	record.startupSeq = fixture.startupSeq

	markInvariantFixtureForTest(s, pluginID)

	return record
}

func setSupervisorServiceRecordForTest(s *Supervisor, pluginID string, fixture *serviceRecord) *pluginRecord {
	s.mu.Lock()

	defer s.unlock()

	return setSupervisorServiceRecordLockedForTest(s, pluginID, fixture)
}

func setSupervisorServiceStateForTest(s *Supervisor, pluginID string, state ServiceState) *pluginRecord {
	s.mu.Lock()

	defer s.unlock()

	record := s.serviceRecordLocked(pluginID)

	if record != nil {
		record.service.status.State = state

		markInvariantFixtureForTest(s, pluginID)
	}

	return record
}

func supervisorServiceForTest(s *Supervisor, pluginID string) *pluginRecord {
	s.mu.Lock()

	defer s.unlock()

	return s.serviceRecordLocked(pluginID)
}

func waitForSupervisorStopForTest(t *testing.T, s *Supervisor, pluginID string) {
	t.Helper()

	s.mu.Lock()

	record := s.serviceRecordLocked(pluginID)
	var stopDone <-chan struct{}

	if record != nil {
		stopDone = record.stopDone
	}

	s.unlock()

	if stopDone == nil {
		return
	}

	select {
	case <-stopDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("service %q stop did not finish exact process reap", pluginID)
	}
}

func supervisorPluginRecordPresentForTest(s *Supervisor, pluginID string) bool {
	s.mu.Lock()

	defer s.unlock()

	return s.plugins[pluginID] != nil
}

func resetSupervisorServicesForTest(s *Supervisor) {
	s.mu.Lock()

	defer s.unlock()

	for pluginID, record := range s.plugins {
		record.launch = nil
		record.process = nil
		record.processRegistered = false

		s.releaseServiceSlotLocked(record)

		record.service = nil
		record.reservationPending = false
		record.stopping = false
		record.stopDone = nil
		record.stopErr = nil
		record.releaseOnStop = false

		s.clearPendingStartLocked(record)

		record.startupQueued = false
		record.startupSeq = 0

		s.prunePluginRecordLocked(pluginID)

		if s.plugins[pluginID] != nil {
			markInvariantFixtureForTest(s, pluginID)
		}
	}
}

func assertSupervisorServiceSlotsInvariantForTest(t *testing.T, s *Supervisor) {
	t.Helper()

	s.mu.Lock()

	defer s.unlock()

	held := 0

	for _, record := range s.plugins {
		if record.serviceHeld {
			held++
		}
	}

	if s.reservedServices != held {
		t.Fatalf("reserved service count = %d, records holding slots = %d", s.reservedServices, held)
	}
}

func setSupervisorTransitionLockedForTest(s *Supervisor, pluginID string, fixture *transition) {
	record := s.plugins[pluginID]

	if fixture == nil {
		if record != nil {
			record.transition = nil

			s.prunePluginRecordLocked(pluginID)

			if s.plugins[pluginID] != nil {
				markInvariantFixtureForTest(s, pluginID)
			}
		}

		return
	}

	record = s.ensureTransitionRecordLocked(pluginID)
	record.transition.intent = fixture.intent
	record.transition.operation = fixture.operation
	record.transition.priorIntent = fixture.priorIntent
	record.transition.run = fixture.run

	markInvariantFixtureForTest(s, pluginID)
}

func setSupervisorTransitionForTest(s *Supervisor, pluginID string, record *transition) {
	s.mu.Lock()

	defer s.unlock()

	setSupervisorTransitionLockedForTest(s, pluginID, record)
}

func scheduleSupervisorRetryForTest(s *Supervisor, pluginID string, delay time.Duration) {
	s.mu.Lock()

	defer s.unlock()

	s.scheduleRetry(pluginID, delay)
}

func seedSupervisorRetryForTest(s *Supervisor, spec ServiceSpec, delay time.Duration) {
	s.mu.Lock()

	defer s.unlock()

	s.setDesiredLocked(spec.PluginID, &spec)
	setSupervisorServiceRecordLockedForTest(s, spec.PluginID, &serviceRecord{
		spec:   spec,
		status: RuntimeStatus{State: StateBackoff},
	})
	setSupervisorTransitionLockedForTest(s, spec.PluginID, &transition{intent: IntentRun})

	s.scheduleRetry(spec.PluginID, delay)
}
