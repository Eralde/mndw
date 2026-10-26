package system

import (
	"context"
	"errors"
	"testing"

	"mndwd/internal/telemetry/ring/ringtest"
)

func TestRunStopsOnContextCancel(t *testing.T) {
	engine, _, _ := startEngine(t, ringtest.NewMemFS(), testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	waitCalled := false
	err := Run(ctx, engine, func(ctx context.Context, _ int64) error {
		waitCalled = true

		return ctx.Err()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context.Canceled", err)
	}

	if waitCalled {
		t.Fatal("Run waited after its context was already canceled")
	}

	if !engine.stopped {
		t.Fatal("Run returned without stopping the engine")
	}
}
