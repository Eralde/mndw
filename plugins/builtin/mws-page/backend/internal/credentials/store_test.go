package credentials

import "testing"

func TestStoreReplacementAndForgetWipeState(t *testing.T) {
	store := NewStore()
	store.Set("admin", []byte("secret"), 1)
	snapshot, state, ok := store.Snapshot()
	if !ok || state != StatePresent || string(snapshot.Password) != "secret" {
		t.Fatalf("snapshot = %#v, %v, %v", snapshot, state, ok)
	}
	store.Set("admin", []byte("new-secret"), 2)
	if got := store.Epoch(); got != 2 {
		t.Fatalf("epoch = %d, want 2", got)
	}
	store.Forget(3)
	if got := store.State(); got != StateAbsent {
		t.Fatalf("state = %q, want absent", got)
	}
	if _, _, ok := store.Snapshot(); ok {
		t.Fatal("forgotten credentials remain available")
	}
}

func TestStoreIgnoresStaleVerdict(t *testing.T) {
	store := NewStore()
	store.Set("admin", []byte("secret"), 2)
	store.MarkInvalid(1)
	if got := store.State(); got != StatePresent {
		t.Fatalf("state = %q after stale invalidation, want present", got)
	}
}
