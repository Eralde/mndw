package backend

import (
	"context"
	"errors"
	"time"
)

// Intent is the desired runtime state for one plugin.
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

type beginOutcome struct {
	run                *operationRun
	joined             bool
	conflict           bool
	supersededWorkDone <-chan struct{}
}

func waitRun(run *operationRun) error {
	<-run.done

	return run.result
}
