package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sub", "state.json")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	return store, path
}

func TestOpenCreatesEmptyStateFile(t *testing.T) {
	store, path := newStore(t)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected state file created on Open: %v", err)
	}
	snap := store.Snapshot()
	if snap.Version != schemaVersion {
		t.Errorf("version = %d, want %d", snap.Version, schemaVersion)
	}
	if len(snap.Plugins) != 0 {
		t.Errorf("expected no plugins, got %d", len(snap.Plugins))
	}
}

func TestMutatePersistsAndReloads(t *testing.T) {
	store, path := newStore(t)

	err := store.Mutate(func(st *State) error {
		st.Plugins["demo"] = &Plugin{
			Name:     "demo",
			Source:   SourceUser,
			Type:     "widget",
			Approval: ApprovalPending,
		}
		st.AppendAudit("upload", "demo", "10240 bytes")

		return nil
	})
	if err != nil {
		t.Fatalf("Mutate: %v", err)
	}

	// A fresh Open must observe the persisted change.
	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	snap := reopened.Snapshot()
	if p, ok := snap.Plugins["demo"]; !ok || p.Approval != ApprovalPending {
		t.Fatalf("persisted plugin not reloaded correctly: %+v", snap.Plugins)
	}
	if len(snap.Audit) != 1 || snap.Audit[0].Action != "upload" {
		t.Fatalf("audit not persisted: %+v", snap.Audit)
	}
}

func TestMutateErrorLeavesStateUntouched(t *testing.T) {
	store, path := newStore(t)

	wantErr := errSentinel("boom")
	err := store.Mutate(func(st *State) error {
		st.Plugins["ghost"] = &Plugin{Name: "ghost"}

		return wantErr
	})
	if err != wantErr {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	// Neither memory nor disk should carry the aborted change.
	if _, ok := store.Get("ghost"); ok {
		t.Error("aborted mutation leaked into live state")
	}
	data, _ := os.ReadFile(path)
	var onDisk State
	_ = json.Unmarshal(data, &onDisk)
	if _, ok := onDisk.Plugins["ghost"]; ok {
		t.Error("aborted mutation leaked to disk")
	}
}

// TestCorruptStateRecovered is the crash-safety property: a garbled state.json
// (e.g. a write torn by power loss) must not wedge startup — it is set aside as
// .bak and startup proceeds from empty state.
func TestCorruptStateRecovered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o644); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open on corrupt state should recover, got: %v", err)
	}
	if len(store.Snapshot().Plugins) != 0 {
		t.Error("expected empty state after recovery")
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Errorf("expected corrupt file preserved as .bak: %v", err)
	}
}

// TestAtomicSaveNoPartialFiles verifies the tmp+rename discipline leaves no
// orphaned temp files behind after a successful mutation — the directory holds
// exactly state.json.
func TestAtomicSaveNoPartialFiles(t *testing.T) {
	store, path := newStore(t)
	dir := filepath.Dir(path)

	for i := 0; i < 5; i++ {
		if err := store.Mutate(func(st *State) error {
			st.AppendAudit("noop", "x", "")

			return nil
		}); err != nil {
			t.Fatalf("Mutate: %v", err)
		}
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "state.json" {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected only state.json in dir, got %v", names)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	store, _ := newStore(t)
	_ = store.Mutate(func(st *State) error {
		st.Plugins["a"] = &Plugin{Name: "a", Enabled: true}

		return nil
	})

	snap := store.Snapshot()
	snap.Plugins["a"].Enabled = false
	snap.Plugins["injected"] = &Plugin{Name: "injected"}

	// Mutating the snapshot must not touch the live store.
	if p, _ := store.Get("a"); !p.Enabled {
		t.Error("snapshot mutation leaked into live state")
	}
	if _, ok := store.Get("injected"); ok {
		t.Error("snapshot insertion leaked into live state")
	}
}

func TestConcurrentMutationsSerialize(t *testing.T) {
	store, _ := newStore(t)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = store.Mutate(func(st *State) error {
				st.AppendAudit("tick", "x", "")

				return nil
			})
		}()
	}
	wg.Wait()

	if got := len(store.Snapshot().Audit); got != 50 {
		t.Errorf("expected 50 serialized audit entries, got %d", got)
	}
}

type errSentinel string

func (e errSentinel) Error() string { return string(e) }
