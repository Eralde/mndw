package state

import (
	"encoding/json"
	"fmt"
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

func TestNewStateUsesSchemaVersionOne(t *testing.T) {
	store, _ := newStore(t)

	if got := store.Snapshot().Version; got != 1 {
		t.Fatalf("state version = %d, want 1", got)
	}
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

	if store.HasGrant("demo", "persistent-rci-session") {
		t.Error("absent grant should default to false")
	}
}

func TestAppendAuditKeepsNewestEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	for i := range MaxAuditEntries + 44 {
		if err := store.Mutate(func(st *State) error {
			st.AppendAudit("test", "", fmt.Sprintf("i=%d", i))

			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	audit := reopened.Snapshot().Audit

	if len(audit) != MaxAuditEntries || audit[0].Detail != "i=44" || audit[len(audit)-1].Detail != fmt.Sprintf("i=%d", MaxAuditEntries+43) {
		t.Fatalf("audit len=%d first=%q last=%q", len(audit), audit[0].Detail, audit[len(audit)-1].Detail)
	}
}

func TestOpenAcceptsOversizedAudit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	st := State{Version: schemaVersion, Plugins: map[string]*Plugin{}, Audit: make([]AuditEntry, MaxAuditEntries+10)}

	for i := range st.Audit {
		st.Audit[i] = AuditEntry{Action: "seed", Detail: fmt.Sprintf("i=%d", i)}
	}

	data, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	if got := len(store.Snapshot().Audit); got != MaxAuditEntries+10 {
		t.Fatalf("audit entries on open = %d, want %d", got, MaxAuditEntries+10)
	}

	if err := store.SetPersistentRCIEnabled(true); err != nil {
		t.Fatal(err)
	}

	audit := store.Snapshot().Audit

	if len(audit) != MaxAuditEntries || audit[len(audit)-1].Action != "persistent-rci-enable" {
		t.Fatalf("audit after mutation len=%d last=%+v", len(audit), audit[len(audit)-1])
	}
}

func TestPersistentRCIEnabledUnsetByDefault(t *testing.T) {
	store, _ := newStore(t)

	enabled, set := store.PersistentRCIEnabled()

	if enabled || set {
		t.Fatalf("PersistentRCIEnabled() = (%t, %t), want (false, false)", enabled, set)
	}
}

func TestSetPersistentRCIEnabledPersistsAndAudits(t *testing.T) {
	store, path := newStore(t)

	if err := store.SetPersistentRCIEnabled(true); err != nil {
		t.Fatalf("enable persistent RCI: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	if enabled, set := reopened.PersistentRCIEnabled(); !enabled || !set {
		t.Fatalf("enabled PersistentRCIEnabled() = (%t, %t), want (true, true)", enabled, set)
	}

	if got := reopened.Snapshot().Audit; len(got) != 1 || got[0].Action != "persistent-rci-enable" || got[0].Plugin != "" {
		t.Fatalf("enable audit = %+v", got)
	}

	if err := reopened.SetPersistentRCIEnabled(false); err != nil {
		t.Fatalf("disable persistent RCI: %v", err)
	}

	if enabled, set := reopened.PersistentRCIEnabled(); enabled || !set {
		t.Fatalf("disabled PersistentRCIEnabled() = (%t, %t), want (false, true)", enabled, set)
	}

	if got := reopened.Snapshot().Audit; len(got) != 2 || got[1].Action != "persistent-rci-disable" || got[1].Plugin != "" {
		t.Fatalf("disable audit = %+v", got)
	}
}

func TestPersistentRCIEnabledReadsStateWithoutField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	legacy := `{"version":1,"plugins":{},"settings":{"backgroundTelemetry":true},"audit":[]}`

	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open state: %v", err)
	}

	if enabled, set := store.PersistentRCIEnabled(); enabled || set {
		t.Fatalf("PersistentRCIEnabled() = (%t, %t), want (false, false)", enabled, set)
	}

	if !store.Snapshot().Settings.BackgroundTelemetry {
		t.Fatal("backgroundTelemetry was lost")
	}

	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("state backup stat error = %v, want no backup", err)
	}
}

func TestSetGrantPersistsAndAudits(t *testing.T) {
	store, path := newStore(t)

	if err := store.SetGrant("demo", "persistent-rci-session", true); err != nil {
		t.Fatalf("enable grant: %v", err)
	}

	if !store.HasGrant("demo", "persistent-rci-session") {
		t.Fatal("enabled grant not visible")
	}

	snap := store.Snapshot()

	if len(snap.Audit) != 1 || snap.Audit[0].Action != "permission-enable" || snap.Audit[0].Plugin != "demo" {
		t.Fatalf("enable audit = %+v", snap.Audit)
	}

	if snap.Audit[0].Detail != "permission=persistent-rci-session" {
		t.Fatalf("enable audit detail = %q", snap.Audit[0].Detail)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	if !reopened.HasGrant("demo", "persistent-rci-session") {
		t.Fatal("enabled grant did not reload")
	}

	if err := reopened.SetGrant("demo", "persistent-rci-session", false); err != nil {
		t.Fatalf("disable grant: %v", err)
	}

	if reopened.HasGrant("demo", "persistent-rci-session") {
		t.Fatal("disabled grant remains enabled")
	}

	if got := len(reopened.Snapshot().Audit); got != 2 {
		t.Fatalf("audit count = %d, want 2", got)
	}

	if got := reopened.Snapshot().Audit[1]; got.Action != "permission-disable" || got.Detail != "permission=persistent-rci-session" {
		t.Fatalf("disable audit = %+v", got)
	}
}

func TestGrantSnapshotIsDeepCopied(t *testing.T) {
	store, _ := newStore(t)

	if err := store.SetGrant("demo", "persistent-rci-session", true); err != nil {
		t.Fatalf("set grant: %v", err)
	}

	snap := store.Snapshot()
	snap.PermissionGrants["demo"]["persistent-rci-session"] = false

	if !store.HasGrant("demo", "persistent-rci-session") {
		t.Fatal("snapshot mutation changed live grant")
	}
}

func TestMutatePersistsAndReloads(t *testing.T) {
	store, path := newStore(t)

	err := store.Mutate(func(st *State) error {
		st.Plugins["demo"] = &Plugin{
			Name:     "demo",
			Source:   SourceUpload,
			Type:     "widget",
			Approval: ApprovalPending,
			Manifest: json.RawMessage(`{}`),
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

func TestUnsupportedStateIsBackedUpWithoutMigration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	legacy := `{"version":2,"plugins":{"old":{"name":"old","source":"user","manifest":{}}}}`

	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("seed legacy state: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open legacy state: %v", err)
	}

	if store.Snapshot().Version != schemaVersion || len(store.Snapshot().Plugins) != 0 {
		t.Fatalf("legacy state was migrated instead of reset: %+v", store.Snapshot())
	}

	backup, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("read legacy backup: %v", err)
	}

	if string(backup) != legacy {
		t.Fatalf("legacy backup changed: %q", backup)
	}
}

func TestStateRetainsVersionProvenance(t *testing.T) {
	store, path := newStore(t)
	err := store.Mutate(func(st *State) error {
		st.Plugins["demo"] = &Plugin{
			Name:             "demo",
			Source:           SourceUpload,
			Approval:         ApprovalApproved,
			Manifest:         json.RawMessage(`{}`),
			InstalledVersion: "1.2.0",
			ActiveVersion:    "1.2.0",
			ActiveVersionDir: filepath.Join(filepath.Dir(path), "plugins", "demo"),
		}

		return nil
	})
	if err != nil {
		t.Fatalf("Mutate: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	plugin, ok := reopened.Get("demo")

	if !ok || plugin.Source != SourceUpload || plugin.ActiveVersion != "1.2.0" {
		t.Fatalf("version provenance not retained: %+v", plugin)
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
		st.Plugins["a"] = &Plugin{Name: "a", Source: SourceUpload, Approval: ApprovalApproved, Enabled: true}

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

// assertRejectedNotPersisted proves a rejected mutation touched neither live
// memory nor the on-disk state.json. Open() writes an initial empty state, so a
// correct Mutate that validates before persisting leaves that empty file intact.
func assertRejectedNotPersisted(t *testing.T, store *Store, path, name string) {
	t.Helper()

	if _, ok := store.Get(name); ok {
		t.Fatalf("rejected plugin %q leaked into live state", name)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state.json: %v", err)
	}

	var onDisk State

	if err := json.Unmarshal(data, &onDisk); err != nil {
		t.Fatalf("unmarshal state.json: %v", err)
	}

	if _, ok := onDisk.Plugins[name]; ok {
		t.Fatalf("rejected plugin %q was persisted to disk", name)
	}
}

func TestMutateRejectsEnabledPendingCombination(t *testing.T) {
	store, path := newStore(t)

	err := store.Mutate(func(st *State) error {
		st.Plugins["svc"] = &Plugin{
			Name:     "svc",
			Source:   SourceUpload,
			Approval: ApprovalPending,
			Enabled:  true, // invalid: enabled must imply approved
			Manifest: json.RawMessage(`{"name":"svc"}`),
		}

		return nil
	})

	if err == nil {
		t.Fatal("Mutate accepted an enabled+pending plugin")
	}

	assertRejectedNotPersisted(t, store, path, "svc")
}

func TestMutateRejectsUnknownApproval(t *testing.T) {
	store, path := newStore(t)

	err := store.Mutate(func(st *State) error {
		st.Plugins["svc"] = &Plugin{
			Name:     "svc",
			Source:   SourceUpload,
			Approval: Approval("granted"), // not a known value
			Enabled:  false,
			Manifest: json.RawMessage(`{"name":"svc"}`),
		}

		return nil
	})

	if err == nil {
		t.Fatal("Mutate accepted an unknown approval value")
	}

	assertRejectedNotPersisted(t, store, path, "svc")
}

func TestMutateRejectsUnknownSource(t *testing.T) {
	store, path := newStore(t)

	err := store.Mutate(func(st *State) error {
		st.Plugins["svc"] = &Plugin{
			Name:     "svc",
			Source:   Source("marketplace"), // not a known value
			Approval: ApprovalApproved,
			Enabled:  true,
			Manifest: json.RawMessage(`{"name":"svc"}`),
		}

		return nil
	})

	if err == nil {
		t.Fatal("Mutate accepted an unknown source value")
	}

	assertRejectedNotPersisted(t, store, path, "svc")
}

func TestLoadBacksUpStateWithUnknownSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	bad := `{"version":1,"plugins":{"svc":{"name":"svc","source":"marketplace","approval":"approved","enabled":true,"manifest":{"name":"svc"}}},"audit":[]}`

	if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	if _, ok := store.Get("svc"); ok {
		t.Fatal("plugin with unknown source was loaded instead of reset")
	}

	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("invalid-source state was not preserved as .bak: %v", err)
	}
}

func TestLoadBacksUpStateWithUnknownApproval(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	bad := `{"version":1,"plugins":{"svc":{"name":"svc","source":"upload","approval":"granted","enabled":false,"manifest":{"name":"svc"}}},"audit":[]}`

	if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	if _, ok := store.Get("svc"); ok {
		t.Fatal("plugin with unknown approval was loaded instead of reset")
	}

	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("invalid-approval state was not preserved as .bak: %v", err)
	}
}

func TestMutateAcceptsValidCombinations(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	cases := []struct {
		approval Approval
		enabled  bool
	}{
		{ApprovalPending, false},
		{ApprovalApproved, true},
		{ApprovalApproved, false},
	}

	for _, tc := range cases {
		err := store.Mutate(func(st *State) error {
			st.Plugins["svc"] = &Plugin{
				Name:     "svc",
				Source:   SourceUpload,
				Approval: tc.approval,
				Enabled:  tc.enabled,
				Manifest: json.RawMessage(`{"name":"svc"}`),
			}

			return nil
		})
		if err != nil {
			t.Fatalf("valid combination %v/%v rejected: %v", tc.approval, tc.enabled, err)
		}
	}
}

func TestLoadBacksUpStateWithInvalidCombination(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	bad := `{"version":1,"plugins":{"svc":{"name":"svc","source":"upload","approval":"pending","enabled":true,"manifest":{"name":"svc"}}},"audit":[]}`

	if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	if _, ok := store.Get("svc"); ok {
		t.Fatal("invalid on-disk plugin was loaded instead of reset")
	}

	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("invalid state was not preserved as .bak: %v", err)
	}
}
