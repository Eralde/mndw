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

// TerminalKind selects the successful stable intent for a lifecycle run.
type TerminalKind int

const (
	TerminalRun TerminalKind = iota
	TerminalStop
	TerminalRemove
)

// FailurePolicy selects the stable intent published after work fails.
type FailurePolicy int

const (
	FailRestore FailurePolicy = iota
	FailKeep
	FailRemoved
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
	success TerminalKind,
	onFail FailurePolicy,
	work func(context.Context, LifecycleControl) error,
) error {
	outcome := r.supervisor.beginLifecycle(name, op, intent)

	return r.executeLifecycleOutcome(name, op, success, onFail, work, outcome)
}

func (r *RuntimeImpl) executeLifecycleOutcome(
	name string,
	op Operation,
	success TerminalKind,
	onFail FailurePolicy,
	work func(context.Context, LifecycleControl) error,
	outcome beginOutcome,
) error {

	if outcome.conflict {
		return ErrLifecycleConflict
	}

	if outcome.joined {
		return waitRun(outcome.run)
	}

	if r.exclusiveOperation(op) && r.closePluginSockets != nil {
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
			switch success {
			case TerminalRun:
				r.supervisor.coord.commitRun(outcome.run)
			case TerminalStop:
				r.supervisor.coord.commitStop(outcome.run)
			case TerminalRemove:
				r.supervisor.coord.commitRemove(outcome.run)
			}

			state := "started"
			reason := "reconciled"

			if success != TerminalRun {
				state = "stopped"
				reason = lifecycleStopReason(op, success)
			}

			lifecycleEvent = &LifecycleEvent{Plugin: name, State: state, Reason: reason}

			return
		}

		switch onFail {
		case FailRestore:
			r.supervisor.coord.failRestore(outcome.run, err)
		case FailKeep:
			r.supervisor.coord.failKeep(outcome.run, err)
		case FailRemoved:
			r.supervisor.coord.failRemoved(outcome.run, err)
		}
	})

	if lifecycleEvent != nil && r.lifecycleObserver != nil {
		r.lifecycleObserver(*lifecycleEvent)
	}

	return waitRun(outcome.run)
}

func lifecycleStopReason(op Operation, success TerminalKind) string {
	if success == TerminalRemove || op == OpDeleting {
		return "removed"
	}

	switch op {
	case OpStopping:
		return "disabled"
	case OpRestarting:
		return "restarted"
	case OpUpdating:
		return "updated"
	default:
		return "reconciled"
	}
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

func (r *RuntimeImpl) exclusiveOperation(op Operation) bool {
	return op == OpStopping || op == OpRestarting || op == OpUpdating || op == OpDeleting || op == OpInstalling
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

		return r.exclusiveOperation(record.operation)
	})
}
