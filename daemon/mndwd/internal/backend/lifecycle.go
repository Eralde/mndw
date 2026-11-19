package backend

import (
	"context"
	"errors"
	"fmt"

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
}

type lifecycleControl struct {
	runtime *Runtime
	token   *lifecycleToken
}

func (c *lifecycleControl) StartPlugin(plugin *registry.Plugin) error {
	if !c.IsCurrent() {
		return errSuperseded
	}

	spec, ok := c.runtime.serviceSpec(plugin)

	if !ok {
		return nil
	}

	return c.runtime.supervisor.startServiceForLifecycle(c.token, spec)
}

func (c *lifecycleControl) StopService() error {
	if !c.IsCurrent() {
		return errSuperseded
	}

	return c.runtime.supervisor.stopServiceForLifecycle(c.token)
}

func (c *lifecycleControl) IsCurrent() bool {
	return c.runtime.supervisor.isLifecycleCurrent(c.token)
}

func (c *lifecycleControl) markServiceReady(record *pluginRecord) bool {
	return c.runtime.supervisor.markLifecycleServiceReady(c.token, record)
}

// ExecuteLifecycle admits, executes, and terminalizes one plugin lifecycle run.
func (r *Runtime) ExecuteLifecycle(
	name string,
	op Operation,
	intent Intent,
	work func(context.Context, LifecycleControl) error,
) error {
	if _, ok := operationTraits[op]; !ok {
		return fmt.Errorf("%w: %d", errUnknownOperation, op)
	}

	outcome := r.supervisor.beginLifecycleOperation(name, op, intent)

	return r.executeLifecycleOutcome(name, op, work, outcome)
}

func (r *Runtime) executeLifecycleOutcome(
	name string,
	op Operation,
	work func(context.Context, LifecycleControl) error,
	outcome lifecycleOperation,
) error {

	if outcome.conflict {
		return ErrLifecycleConflict
	}

	if outcome.joined {
		return r.supervisor.waitLifecycle(outcome.token)
	}

	if traitsOf(op).exclusive {
		r.supervisor.closePluginSockets(name)
	}

	if outcome.supersededWorkDone != nil {
		<-outcome.supersededWorkDone
	}

	control := &lifecycleControl{runtime: r, token: outcome.token}
	err := r.supervisor.runLifecycleWork(outcome.token, control, work)

	if r.supervisor.releaseUnstartedReservationForLifecycle(outcome.token) {
		r.supervisor.promoteBlocked()
	}

	var lifecycleEvent *LifecycleEvent

	if err == nil {
		lifecycleEvent = r.supervisor.finishLifecycle(outcome.token, op)
	} else {
		r.supervisor.failLifecycle(outcome.token, err)
	}

	if lifecycleEvent != nil {
		r.lifecycleObserver(*lifecycleEvent)
	}

	return r.supervisor.waitLifecycle(outcome.token)
}

// BlocksTraffic reports whether plugin traffic must remain gated.
func (r *Runtime) BlocksTraffic(pluginID string) bool {
	return r.supervisor.blocksTraffic(pluginID)
}
