package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
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

func stateBackupPaths(t *testing.T, path string) []string {
	t.Helper()

	paths, err := filepath.Glob(path + ".bak-*")
	if err != nil {
		t.Fatalf("list state backups: %v", err)
	}

	return paths
}

func oneStateBackup(t *testing.T, path string) string {
	t.Helper()

	paths := stateBackupPaths(t, path)

	if len(paths) != 1 {
		t.Fatalf("state backup count = %d, want one (%#v)", len(paths), paths)
	}

	return paths[0]
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

	if store.HasCapabilityGrant("demo", "persistent-rci-session") {
		t.Error("absent grant should default to false")
	}
}

func TestOpenMigratesLegacyPermissionGrantsAndRewritesState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	legacy := `{"version":1,"plugins":{},"permissionGrants":{"demo":{"persistent-rci-session:read":true}},"audit":[]}`

	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("seed legacy state: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open legacy state: %v", err)
	}

	if !store.HasCapabilityGrant("demo", "persistent-rci-session:read") {
		t.Fatal("legacy grant was not loaded")
	}

	if err := store.SetCapabilityGrant("demo", "persistent-rci-session:write", true); err != nil {
		t.Fatalf("write migrated state: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rewritten state: %v", err)
	}

	var persisted map[string]json.RawMessage

	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatalf("decode rewritten state: %v", err)
	}

	if _, ok := persisted["permissionGrants"]; ok {
		t.Fatal("rewritten state retained permissionGrants")
	}

	if _, ok := persisted["capabilityGrants"]; !ok {
		t.Fatal("rewritten state omitted capabilityGrants")
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

	if backups := stateBackupPaths(t, path); len(backups) != 0 {
		t.Fatalf("state backups = %#v, want none", backups)
	}
}

func TestSetCapabilityGrantPersistsAndAudits(t *testing.T) {
	store, path := newStore(t)

	if err := store.SetCapabilityGrant("demo", "persistent-rci-session", true); err != nil {
		t.Fatalf("enable grant: %v", err)
	}

	if !store.HasCapabilityGrant("demo", "persistent-rci-session") {
		t.Fatal("enabled grant not visible")
	}

	snap := store.Snapshot()

	if len(snap.Audit) != 1 || snap.Audit[0].Action != "capability-enable" || snap.Audit[0].Plugin != "demo" {
		t.Fatalf("enable audit = %+v", snap.Audit)
	}

	if snap.Audit[0].Detail != "capability=persistent-rci-session" {
		t.Fatalf("enable audit detail = %q", snap.Audit[0].Detail)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	if !reopened.HasCapabilityGrant("demo", "persistent-rci-session") {
		t.Fatal("enabled grant did not reload")
	}

	if err := reopened.SetCapabilityGrant("demo", "persistent-rci-session", false); err != nil {
		t.Fatalf("disable grant: %v", err)
	}

	if reopened.HasCapabilityGrant("demo", "persistent-rci-session") {
		t.Fatal("disabled grant remains enabled")
	}

	if got := len(reopened.Snapshot().Audit); got != 2 {
		t.Fatalf("audit count = %d, want 2", got)
	}

	if got := reopened.Snapshot().Audit[1]; got.Action != "capability-disable" || got.Detail != "capability=persistent-rci-session" {
		t.Fatalf("disable audit = %+v", got)
	}
}

func TestGrantSnapshotIsDeepCopied(t *testing.T) {
	store, _ := newStore(t)

	if err := store.SetCapabilityGrant("demo", "persistent-rci-session", true); err != nil {
		t.Fatalf("set grant: %v", err)
	}

	snap := store.Snapshot()
	snap.CapabilityGrants["demo"]["persistent-rci-session"] = false

	if !store.HasCapabilityGrant("demo", "persistent-rci-session") {
		t.Fatal("snapshot mutation changed live grant")
	}
}

func TestCapabilityGrantsWinWhenBothStateKeysExist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	both := `{"version":1,"plugins":{},"permissionGrants":{"demo":{"persistent-rci-session:read":true}},"capabilityGrants":{"demo":{"persistent-rci-session:read":false}},"audit":[]}`

	if err := os.WriteFile(path, []byte(both), 0o600); err != nil {
		t.Fatalf("seed state with both grant keys: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open state with both grant keys: %v", err)
	}

	if store.HasCapabilityGrant("demo", "persistent-rci-session:read") {
		t.Fatal("legacy grant overrode capabilityGrants")
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
// (e.g. a write torn by power loss) must be backed up before startup proceeds
// from empty state.
func TestCorruptStateRecovered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := os.WriteFile(path, []byte("{ this is not json"), 0o644); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	store, err := Open(path, logger)
	if err != nil {
		t.Fatalf("Open on corrupt state should recover, got: %v", err)
	}

	if len(store.Snapshot().Plugins) != 0 {
		t.Error("expected empty state after recovery")
	}

	backups := stateBackupPaths(t, path)

	if len(backups) != 1 {
		t.Fatalf("state backups = %#v, want one timestamped backup", backups)
	}

	backup, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatalf("read state backup: %v", err)
	}

	if string(backup) != "{ this is not json" {
		t.Fatalf("state backup = %q, want original corrupt bytes", backup)
	}

	if !strings.Contains(logs.String(), "corrupt state backed up") || !strings.Contains(logs.String(), backups[0]) {
		t.Errorf("backup warning = %q, want supplied logger to record backup path", logs.String())
	}
}

func TestOpenKeepsEarlierCorruptStateBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	first := []byte("first corrupt state")

	if err := os.WriteFile(path, first, 0o600); err != nil {
		t.Fatalf("seed first corrupt state: %v", err)
	}

	if _, err := Open(path); err != nil {
		t.Fatalf("open first corrupt state: %v", err)
	}

	second := []byte("second corrupt state")

	if err := os.WriteFile(path, second, 0o600); err != nil {
		t.Fatalf("seed second corrupt state: %v", err)
	}

	if _, err := Open(path); err != nil {
		t.Fatalf("open second corrupt state: %v", err)
	}

	backups := stateBackupPaths(t, path)

	if len(backups) != 2 {
		t.Fatalf("state backup count = %d, want 2 (%#v)", len(backups), backups)
	}

	got := make(map[string]bool, len(backups))

	for _, backupPath := range backups {
		data, err := os.ReadFile(backupPath)
		if err != nil {
			t.Fatalf("read state backup %q: %v", backupPath, err)
		}

		got[string(data)] = true
	}

	if !got[string(first)] || !got[string(second)] {
		t.Fatalf("state backup contents = %#v, want both original corrupt files", got)
	}
}

func TestOpenReturnsErrorWhenCorruptStateCannotBeBackedUp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	original := []byte("corrupt state that must stay in place")

	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatalf("seed corrupt state: %v", err)
	}

	wantErr := errors.New("backup rename failed")
	previousRename := renameBackupFile
	renameBackupFile = func(_, _ string) error { return wantErr }

	defer func() { renameBackupFile = previousRename }()

	if _, err := Open(path); !errors.Is(err, wantErr) {
		t.Fatalf("Open error = %v, want backup error %v", err, wantErr)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read original state after backup failure: %v", err)
	}

	if string(got) != string(original) {
		t.Fatalf("original state after backup failure = %q, want unchanged %q", got, original)
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

	backup, err := os.ReadFile(oneStateBackup(t, path))
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

	oneStateBackup(t, path)
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

	oneStateBackup(t, path)
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

	oneStateBackup(t, path)
}
