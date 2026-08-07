package credentials

import (
	"context"
	"sync"
)

// Epoch serializes intake/forget replacement. A completion is allowed to write
// only when its captured token still names the current generation.
type Epoch struct {
	mu     sync.Mutex
	value  uint64
	cancel context.CancelFunc
}

func NewEpoch() *Epoch { return &Epoch{} }

func (e *Epoch) Begin(parent context.Context) (uint64, context.Context) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cancel != nil {
		e.cancel()
	}
	ctx, cancel := context.WithCancel(parent)
	e.value++
	e.cancel = cancel
	return e.value, ctx
}

func (e *Epoch) Current() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.value
}

func (e *Epoch) CurrentIs(token uint64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return token == e.value
}

func (e *Epoch) Cancel() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cancel != nil {
		e.cancel()
		e.cancel = nil
	}
}
