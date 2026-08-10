package chansem

import (
	"context"
	"testing"
	"time"
)

func TestAcquireAndReleaseUseChannelToken(t *testing.T) {
	t.Parallel()

	slots := make(chan struct{}, 1)
	if err := Acquire(context.Background(), slots); err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}

	select {
	case slots <- struct{}{}:
		t.Fatal("second token acquired while slot was held")
	default:
	}

	Release(slots)
	if err := Acquire(context.Background(), slots); err != nil {
		t.Fatalf("Acquire() after Release() error = %v", err)
	}
}

func TestAcquireReturnsPreCanceledContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Acquire(ctx, make(chan struct{}, 1)); err != context.Canceled {
		t.Fatalf("Acquire() error = %v, want %v", err, context.Canceled)
	}
}

func TestAcquireUnblocksWhenContextIsCanceled(t *testing.T) {
	t.Parallel()

	slots := make(chan struct{}, 1)
	if err := Acquire(context.Background(), slots); err != nil {
		t.Fatalf("initial Acquire() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- Acquire(ctx, slots)
	}()

	cancel()
	select {
	case err := <-result:
		if err != context.Canceled {
			t.Fatalf("Acquire() error = %v, want %v", err, context.Canceled)
		}
	case <-time.After(time.Second):
		t.Fatal("Acquire() did not unblock after cancellation")
	}
}
