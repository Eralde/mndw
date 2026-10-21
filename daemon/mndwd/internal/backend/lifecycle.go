package backend

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"

	"mndwd/internal/registry"
)

var (
	ErrLifecycleConflict = errors.New("lifecycle conflict")
	ErrForceStopTerminal = errors.New("force stop terminal")
	errWorkPanic         = errors.New("lifecycle work panic")
)

// LifecycleControl exposes generation-bound physical service work.
type LifecycleControl interface {
	StartPlugin(plugin *registry.Plugin) error
	StopService() error
	IsCurrent() bool
	Generation() uint64
}

type lifecycleControl struct {
	runtime *RuntimeImpl
	run     *operationRun
}

func (c *lifecycleControl) StartPlugin(plugin *registry.Plugin) error {
	if !c.IsCurrent() {
		return errSuperseded
	}

	spec, ok := c.runtime.serviceSpec(plugin)

	if !ok {
		return nil
	}

	return c.runtime.supervisor.startService(c.run, spec)
}

func (c *lifecycleControl) StopService() error {
	if !c.IsCurrent() {
		return errSuperseded
	}

	return c.runtime.supervisor.stopService(c.run)
}

func (c *lifecycleControl) IsCurrent() bool {
	return c.runtime.supervisor.isCurrent(c.run)
}

func (c *lifecycleControl) Generation() uint64 {
	return c.run.generation
}

// ExecuteLifecycle admits, executes, and terminalizes one plugin lifecycle run.
func (r *RuntimeImpl) ExecuteLifecycle(
	name string,
	op Operation,
	intent Intent,
	work func(context.Context, LifecycleControl) error,
) error {
	if _, ok := operationTraits[op]; !ok {
		return fmt.Errorf("%w: %d", errUnknownOperation, op)
	}

	outcome := r.supervisor.beginLifecycle(name, op, intent)

	return r.executeLifecycleOutcome(name, op, work, outcome)
}

func (r *RuntimeImpl) executeLifecycleOutcome(
	name string,
	op Operation,
	work func(context.Context, LifecycleControl) error,
	outcome beginOutcome,
) error {

	if outcome.conflict {
		return ErrLifecycleConflict
	}

	if outcome.joined {
		return waitRun(outcome.run)
	}

	if traitsOf(op).exclusive && r.closePluginSockets != nil {
		r.closePluginSockets(name)
	}

	if outcome.supersededWorkDone != nil {
		<-outcome.supersededWorkDone
	}

	control := &lifecycleControl{runtime: r, run: outcome.run}
	err := r.runLifecycleWork(outcome.run, control, work)
	var lifecycleEvent *LifecycleEvent

	r.supervisor.withLock(func() {
		if errors.Is(err, ErrForceStopTerminal) {
			r.supervisor.coord.forceStop(outcome.run, err)

			return
		}

		if err == nil {
			r.supervisor.coord.commit(outcome.run)

			state := LifecycleStopped
			reason := lifecycleStopReason(op, outcome.run.targetIntent)

			if outcome.run.targetIntent == IntentRun {
				state = LifecycleStarted
				reason = LifecycleReasonReconciled
			}

			lifecycleEvent = &LifecycleEvent{Plugin: name, State: state, Reason: reason}

			return
		}

		r.supervisor.coord.fail(outcome.run, err)
	})

	if lifecycleEvent != nil && r.lifecycleObserver != nil {
		r.lifecycleObserver(*lifecycleEvent)
	}

	return waitRun(outcome.run)
}

func (r *RuntimeImpl) runLifecycleWork(
	run *operationRun,
	control LifecycleControl,
	work func(context.Context, LifecycleControl) error,
) (err error) {
	defer close(run.workDone)

	defer func() {
		if recovered := recover(); recovered != nil {
			stack := debug.Stack()
			err = fmt.Errorf("%w: %v", errWorkPanic, recovered)

			if r.supervisor.cfg.Logger != nil {
				r.supervisor.cfg.Logger.Error("lifecycle work panicked", "plugin", run.name, "operation", run.op, "panic", recovered, "stack", string(stack))
			}
		}
	}()

	return work(run.ctx, control)
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

// BlocksTraffic reports whether plugin traffic must remain gated.
func (r *RuntimeImpl) BlocksTraffic(pluginID string) bool {
	return withLockValue(r.supervisor, func() bool {
		record := r.supervisor.coord.records[pluginID]

		if record == nil {
			return false
		}

		if record.intent == IntentStop || record.intent == IntentRemove {
			return true
		}

		return traitsOf(record.operation).exclusive
	})
}
