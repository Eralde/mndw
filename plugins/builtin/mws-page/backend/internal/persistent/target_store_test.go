package persistent

import (
	"sync"
	"testing"
	"time"

	"mndw.local/rcisock"
)

func newTestStore(now Clock) *targetStore {
	var mu sync.Mutex

	return newTargetStore(&mu, now, newDiagnosticsRecorder(&mu, now, Diagnostics{}), defaultSessionRetention)
}

func rcisockOK() rcisock.ResponseFrame { return rcisock.ResponseFrame{Status: 200} }

func TestTargetStoreKeepsStableLockAcrossRemoveReAdd(t *testing.T) {
	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	store := newTestStore(func() time.Time { return fixed })

	if err := store.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	first := store.lockFor("cid-1")

	if first == nil {
		t.Fatal("lockFor(cid-1) = nil, want a per-target lock")
	}

	if err := store.updateTargets(nil); err != nil {
		t.Fatal(err)
	}

	if err := store.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	if store.lockFor("cid-1") != first {
		t.Fatal("lock object changed across remove/re-add — per-target serialization would break")
	}
}

func TestTargetStoreSnapshotReflectsReEnumeratedMAC(t *testing.T) {
	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	store := newTestStore(func() time.Time { return fixed })

	if err := store.updateTargets([]Target{{Identity: "cid-1", Name: "old", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	store.applyResult(Target{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}, rcisockOK(), nil)

	if err := store.updateTargets([]Target{{Identity: "cid-1", Name: "new", MAC: "11:22:33:44:55:66"}}); err != nil {
		t.Fatal(err)
	}

	sessions := store.snapshot()

	if len(sessions) != 1 {
		t.Fatalf("snapshot len = %d, want 1", len(sessions))
	}

	if sessions[0].Mac != "11:22:33:44:55:66" {
		t.Fatalf("snapshot MAC = %q, want re-enumerated value (single source of truth)", sessions[0].Mac)
	}
}

func TestTargetStoreSnapshotExpiresByInjectedClock(t *testing.T) {
	current := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	store := newTestStore(func() time.Time { return current })

	if err := store.updateTargets([]Target{{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}}); err != nil {
		t.Fatal(err)
	}

	store.applyResult(Target{Identity: "cid-1", MAC: "aa:bb:cc:dd:ee:ff"}, rcisockOK(), nil)

	if got := store.snapshot(); len(got) != 1 {
		t.Fatalf("snapshot before expiry = %d, want 1", len(got))
	}

	current = current.Add(defaultSessionRetention + time.Second)

	if got := store.snapshot(); len(got) != 0 {
		t.Fatalf("snapshot after retention = %d, want 0 (clock-driven expiry)", len(got))
	}
}
