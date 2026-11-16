package backend

import (
	"context"
	"net/http"
	"os"
	"time"

	"mndwd/internal/httpx"
)

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

func newCoordinator(lifetimeCtx context.Context) *coordinator {
	return newCoordinatorWithClock(lifetimeCtx, time.Now)
}

func (c *coordinator) intentOf(name string) Intent {
	record := c.records[name]

	if record == nil {
		return IntentRemove
	}

	return record.intent
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

func (s *Supervisor) planStart(spec ServiceSpec, paths RuntimePaths) startPlan {
	return withLockValue(s, func() startPlan {
		return s.planStartLocked(spec, paths)
	})
}

func (r *RuntimeImpl) operationOf(name string) Operation {
	return r.supervisor.operationOf(name)
}

func (r *RuntimeImpl) intentOf(name string) Intent {
	return r.supervisor.intentOf(name)
}

func (r *RuntimeImpl) generationOf(name string) uint64 {
	return withLockValue(r.supervisor, func() uint64 {
		record := r.supervisor.coord.records[name]

		if record == nil || record.run == nil {
			return 0
		}

		return record.run.generation
	})
}
