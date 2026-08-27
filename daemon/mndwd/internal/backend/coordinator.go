package backend

import (
	"context"
	"errors"
	"time"
)

// Intent is the coordinator's desired runtime state for one plugin.
type Intent int

const (
	IntentRun Intent = iota
	IntentStop
	IntentRemove
)

// Operation is the accepted lifecycle operation currently owning a plugin.
type Operation int

const (
	OpNone Operation = iota
	OpStarting
	OpStopping
	OpRestarting
	OpUpdating
	OpDeleting
	OpInstalling
)

var errSuperseded = errors.New("operation superseded")

type operationRun struct {
	name         string
	generation   uint64
	op           Operation
	targetIntent Intent
	ctx          context.Context
	done         chan struct{}
	result       error
	completed    bool
	workDone     chan struct{}
	cancel       context.CancelFunc
}

type transition struct {
	intent      Intent
	operation   Operation
	priorIntent Intent
	run         *operationRun
	phaseSince  time.Time
}

type coordinator struct {
	records     map[string]*transition
	nextGen     uint64
	lifetimeCtx context.Context
}

type beginOutcome struct {
	run                *operationRun
	joined             bool
	conflict           bool
	supersededWorkDone <-chan struct{}
}

func joinable(op Operation) bool {
	return op == OpDeleting || op == OpStopping || op == OpRestarting
}

func newCoordinator(parent ...context.Context) *coordinator {
	lifetimeCtx := context.Background()

	if len(parent) > 0 && parent[0] != nil {
		lifetimeCtx = parent[0]
	}

	return &coordinator{
		records:     make(map[string]*transition),
		lifetimeCtx: lifetimeCtx,
	}
}

// intentOf requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) intentOf(name string) Intent {
	record := c.records[name]

	if record == nil {
		return IntentRemove
	}

	return record.intent
}

// begin requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) begin(name string, op Operation, want Intent) beginOutcome {
	record := c.records[name]

	if record != nil && record.operation != OpNone {
		if record.operation == op && joinable(op) {
			return beginOutcome{run: record.run, joined: true}
		}

		if (op == OpDeleting || op == OpStopping) &&
			(record.operation == OpStarting || record.operation == OpRestarting) {
			oldRun := record.run

			c.completeSuperseded(oldRun)
			oldRun.cancel()

			run := c.newRun(name, op, want)
			c.records[name] = &transition{
				intent:      want,
				operation:   op,
				priorIntent: record.intent,
				run:         run,
				phaseSince:  time.Now(),
			}

			return beginOutcome{run: run, supersededWorkDone: oldRun.workDone}
		}

		return beginOutcome{conflict: true}
	}

	priorIntent := IntentRemove

	if record != nil {
		priorIntent = record.intent

		if record.intent == IntentRemove && op != OpInstalling && op != OpDeleting {
			return beginOutcome{conflict: true}
		}
	}

	run := c.newRun(name, op, want)
	c.records[name] = &transition{
		intent:      want,
		operation:   op,
		priorIntent: priorIntent,
		run:         run,
		phaseSince:  time.Now(),
	}

	return beginOutcome{run: run}
}

// isCurrent requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) isCurrent(run *operationRun) bool {
	if run == nil || run.completed {
		return false
	}

	record := c.records[run.name]

	return record != nil && record.run == run && record.operation == run.op
}

// commitRun requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) commitRun(run *operationRun) {
	c.terminalize(run, IntentRun, nil)
}

// commitStop requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) commitStop(run *operationRun) {
	c.terminalize(run, IntentStop, nil)
}

// commitRemove requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) commitRemove(run *operationRun) {
	if !c.isCurrent(run) {
		return
	}

	c.nextGen++

	c.terminalize(run, IntentRemove, nil)
}

// failRestore requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) failRestore(run *operationRun, err error) {
	record := c.records[run.name]

	if record == nil {
		return
	}

	c.terminalize(run, record.priorIntent, err)
}

// failKeep requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) failKeep(run *operationRun, err error) {
	if run == nil {
		return
	}

	c.terminalize(run, run.targetIntent, err)
}

// failRemoved requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) failRemoved(run *operationRun, err error) {
	c.terminalize(run, IntentRemove, err)
}

// forceStop requires Supervisor.mu held when used by a Supervisor.
func (c *coordinator) forceStop(run *operationRun, err error) {
	c.terminalize(run, IntentStop, err)
}

func (c *coordinator) newRun(name string, op Operation, want Intent) *operationRun {
	c.nextGen++
	ctx, cancel := context.WithCancel(c.lifetimeCtx)

	return &operationRun{
		name:         name,
		generation:   c.nextGen,
		op:           op,
		targetIntent: want,
		ctx:          ctx,
		done:         make(chan struct{}),
		workDone:     make(chan struct{}),
		cancel:       cancel,
	}
}

func (c *coordinator) terminalize(run *operationRun, intent Intent, err error) {
	if !c.isCurrent(run) {
		return
	}

	record := c.records[run.name]
	record.intent = intent
	record.operation = OpNone
	record.phaseSince = time.Now()
	run.result = err
	run.completed = true

	run.cancel()
	close(run.done)
}

func (c *coordinator) completeSuperseded(run *operationRun) {
	if run == nil || run.completed {
		return
	}

	run.result = errSuperseded
	run.completed = true

	close(run.done)
}

func waitRun(run *operationRun) error {
	<-run.done

	return run.result
}
