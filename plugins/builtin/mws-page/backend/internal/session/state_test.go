package session

import (
	"testing"
	"time"
)

func TestEnsureCreatesOfflineNode(t *testing.T) {
	state := NewState()

	state.Ensure("node")
	snapshot, ok := state.Snapshot("node")
	if !ok {
		t.Fatal("Ensure() did not create node")
	}
	if snapshot.State != NodeOffline {
		t.Fatalf("state = %q, want %q", snapshot.State, NodeOffline)
	}
}

func TestStateRecordsAuthenticationSuccessWithoutTreatingDiscoveryAsSuccess(t *testing.T) {
	state := NewState()
	first := time.Date(2026, time.August, 3, 19, 42, 10, 0, time.FixedZone("CEST", 2*60*60))
	second := first.Add(time.Minute)

	state.SetOnline("node", first)
	snapshot, ok := state.Snapshot("node")
	if !ok {
		t.Fatal("discovered node missing from state")
	}
	if !snapshot.LastSuccess.IsZero() {
		t.Fatalf("discovery recorded last success: %v", snapshot.LastSuccess)
	}

	state.RecordSuccess("node", second)
	snapshot, _ = state.Snapshot("node")
	if !snapshot.LastSuccess.Equal(second) {
		t.Fatalf("last success = %v, want %v", snapshot.LastSuccess, second)
	}
}

func TestStateRetainsLastSuccessAcrossFailureAndReplacesItOnNextSuccess(t *testing.T) {
	state := NewState()
	first := time.Unix(100, 0)
	second := first.Add(2 * time.Minute)
	third := second.Add(2 * time.Minute)

	state.RecordSuccess("node", first)
	state.RecordFailure("node", second)
	snapshot, _ := state.Snapshot("node")
	if !snapshot.LastSuccess.Equal(first) {
		t.Fatalf("failure cleared last success: %v", snapshot.LastSuccess)
	}

	state.RecordSuccess("node", third)
	snapshot, _ = state.Snapshot("node")
	if !snapshot.LastSuccess.Equal(third) {
		t.Fatalf("last success = %v, want %v", snapshot.LastSuccess, third)
	}
}
