package persistent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func newTestDispatcher(maxInflight int, ioTimeout time.Duration) (*dispatcher, *targetStore) {
	var mu sync.Mutex
	now := func() time.Time { return time.Unix(0, 0).UTC() }
	store := newTargetStore(&mu, now, newDiagnosticsRecorder(&mu, now, Diagnostics{}), defaultSessionRetention)

	return newDispatcher(&mu, maxInflight, store, ioTimeout), store
}

func TestDispatcherSendRejectsUnknownTargetWithoutRPC(t *testing.T) {
	d, _ := newTestDispatcher(8, time.Second)

	if _, err := d.send(context.Background(), "cid-unknown", Request{Method: "POST", Path: "rci/"}); !errors.Is(err, ErrNoSession) {
		t.Fatalf("send unknown target error = %v, want ErrNoSession", err)
	}
}

func TestDispatcherCallHonoursCallerCancellation(t *testing.T) {
	d, store := newTestDispatcher(8, time.Second)

	if err := store.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	if _, err := d.call(ctx, nil, "cid-1", Request{Method: "GET", Path: "rci/show/version"}); err == nil {
		t.Fatal("call with cancelled context returned nil error, want cancellation error")
	}
}

func TestDispatcherInflightLimitBlocksBeyondCapacity(t *testing.T) {
	d, _ := newTestDispatcher(1, time.Second)

	if err := acquire(context.Background(), d.inflight); err != nil {
		t.Fatalf("first acquire = %v, want nil", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)

	defer cancel()

	if err := acquire(ctx, d.inflight); err == nil {
		t.Fatal("second acquire returned nil, want deadline-exceeded (limit not enforced)")
	}

	release(d.inflight)
}
