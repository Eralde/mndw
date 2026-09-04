package telemetry

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"mndw.local/rrd"
)

type capabilityExecutor struct {
	mu       sync.Mutex
	commands [][]string
	err      error
}

func (e *capabilityExecutor) Run(_ context.Context, args ...string) (rrd.ExecResult, error) {
	e.mu.Lock()

	e.commands = append(e.commands, append([]string(nil), args...))

	e.mu.Unlock()

	return rrd.ExecResult{}, e.err
}

func (e *capabilityExecutor) commandCount() int {
	e.mu.Lock()

	defer e.mu.Unlock()

	return len(e.commands)
}

func TestCapabilityDisabledConstructionDoesNoRRDWork(t *testing.T) {
	executor := &capabilityExecutor{}
	capability, err := NewCapability(CapabilityConfig{
		Executor:       executor,
		RRDDir:         t.TempDir(),
		DesiredEnabled: func() bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}

	if capability.IsEnabled() {
		t.Fatal("disabled capability reports enabled")
	}

	if got := executor.commandCount(); got != 0 {
		t.Fatalf("constructor invoked RRDtool %d times", got)
	}
}

func TestCapabilityDisableCancelsAndJoinsBootRetry(t *testing.T) {
	executor := &capabilityExecutor{err: errors.New("rrdtool unavailable")}
	waitStarted := make(chan struct{})
	waiter := func(ctx context.Context, _ time.Duration) error {
		select {
		case waitStarted <- struct{}{}:
		default:
		}

		<-ctx.Done()

		return ctx.Err()
	}
	capability, err := NewCapability(CapabilityConfig{
		Executor:       executor,
		RRDDir:         t.TempDir(),
		DesiredEnabled: func() bool { return true },
		Wait:           waiter,
		RetryBackoff:   []time.Duration{time.Hour},
	})
	if err != nil {
		t.Fatal(err)
	}

	retryDone := make(chan error, 1)

	go func() { retryDone <- capability.StartWithRetry(context.Background()) }()

	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		t.Fatal("retry did not reach backoff")
	}

	if err := capability.SetEnabled(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-retryDone:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("retry returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("disable returned before retry stopped")
	}
}
