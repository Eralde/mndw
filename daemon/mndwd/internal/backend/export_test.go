package backend

import (
	"context"
	"net/http"
	"os"
	"time"

	"mndwd/internal/httpx"
)

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
	transitionPresent  bool
	intent             Intent
	operation          Operation
	generation         uint64
}

type lifecycleReadinessMarker interface {
	markServiceReady(*serviceRecord) bool
}

func markLifecycleServiceReady(control LifecycleControl, record *serviceRecord) bool {
	marker, ok := control.(lifecycleReadinessMarker)

	return ok && marker.markServiceReady(record)
}

func NewExecRunner(cfg ExecRunnerConfig) *ExecRunner {
	cfg = normalizeExecConfig(cfg)

	return newExecRunner(cfg, NewAdmission(Limits{
		MaxConcurrentExecTotal:     cfg.MaxConcurrentExecTotal,
		MaxConcurrentExecPerPlugin: cfg.MaxConcurrentExecPerPlugin,
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
	cfg = normalizeSupervisorConfig(cfg)

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

	defer s.mu.Unlock()

	plan := s.planStartLocked(spec, paths)

	return startPlanSnapshot{action: plan.action, err: plan.err}
}

func (s *Supervisor) pluginSnapshot(name string) pluginSnapshot {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.pluginSnapshotLocked(name)
}

func (s *Supervisor) pluginSnapshotLocked(name string) pluginSnapshot {
	snapshot := pluginSnapshot{intent: IntentRemove}

	if desired, ok := s.desired[name]; ok {
		snapshot.desiredPresent = true
		snapshot.desired = desired
		snapshot.desired.Args = append([]string(nil), desired.Args...)
	}

	if record := s.services[name]; record != nil {
		snapshot.servicePresent = true
		snapshot.status = cloneRuntimeStatus(record.status)
		snapshot.serviceSlotHeld = record.reservation != nil
		snapshot.reservationPending = record.reservationPending
		snapshot.startupQueued = record.startupQueued
		snapshot.startupSeq = record.startupSeq
	}

	transition := s.transitionStateLocked(name)

	if transition.present {
		snapshot.transitionPresent = true
		snapshot.intent = transition.intent
		snapshot.operation = transition.operation
		snapshot.generation = transition.generation
	}

	snapshot.retryTimerPresent = s.retryTimers[name] != nil

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

func (r *RuntimeImpl) operationOf(name string) Operation {
	return r.supervisor.operationOf(name)
}

func (r *RuntimeImpl) intentOf(name string) Intent {
	return r.supervisor.intentOf(name)
}

func (r *RuntimeImpl) generationOf(name string) uint64 {
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

	defer s.mu.Unlock()

	if desired != nil {
		s.desired[pluginID] = *desired
	}

	if service != nil {
		s.services[pluginID] = service
	}

	if transition != nil {
		s.transitions[pluginID] = transition
	}
}

func setSupervisorServiceStateForTest(s *Supervisor, pluginID string, state ServiceState) *serviceRecord {
	s.mu.Lock()

	defer s.mu.Unlock()

	record := s.services[pluginID]

	if record != nil {
		record.status.State = state
	}

	return record
}

func supervisorServiceForTest(s *Supervisor, pluginID string) *serviceRecord {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.services[pluginID]
}

func setSupervisorTransitionForTest(s *Supervisor, pluginID string, record *transition) {
	s.mu.Lock()

	defer s.mu.Unlock()

	if record == nil {
		delete(s.transitions, pluginID)

		return
	}

	s.transitions[pluginID] = record
}

func scheduleSupervisorRetryForTest(s *Supervisor, pluginID string, delay time.Duration) {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.scheduleRetry(pluginID, delay)
}

func seedSupervisorRetryForTest(s *Supervisor, spec ServiceSpec, delay time.Duration) {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.desired[spec.PluginID] = spec
	s.services[spec.PluginID] = &serviceRecord{spec: spec, status: RuntimeStatus{State: StateBackoff}}
	s.transitions[spec.PluginID] = &transition{intent: IntentRun}

	s.scheduleRetry(spec.PluginID, delay)
}
