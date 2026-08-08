package registry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

func newRegistry(t *testing.T) (*Registry, *state.Store, string, string) {
	t.Helper()
	root := t.TempDir()
	userDir := filepath.Join(root, "user-plugins")
	builtinDir := filepath.Join(root, "builtin")
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	return New(store, userDir, builtinDir), store, userDir, builtinDir
}

func TestResolveUserPlugin(t *testing.T) {
	reg, store, userDir, _ := newRegistry(t)
	m := `{"manifestVersion":3,"name":"svc","version":"1.0.0","type":"widget","label":"W","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"exec","routes":[{"id":"status","transport":"http","method":"GET","path":"status","access":"public","command":"backend/status.sh"}]}}`
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["svc"] = &state.Plugin{Name: "svc", Source: state.SourceUser, Approval: state.ApprovalApproved, Enabled: true, Manifest: json.RawMessage(m)}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	p, ok := reg.Resolve("svc")
	if !ok {
		t.Fatal("expected to resolve svc")
	}
	if p.Dir != filepath.Join(userDir, "svc") {
		t.Errorf("dir = %q", p.Dir)
	}
	if p.Source != state.SourceUser || p.Approval != state.ApprovalApproved || !p.Enabled {
		t.Errorf("unexpected state: %+v", p)
	}
}

func TestResolveBuiltin(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)
	dir := filepath.Join(builtinDir, "core")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	m := `{"manifestVersion":3,"name":"core","version":"2.0.0","type":"page","label":"C","entry":"index.js","route":"/core"}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(m), 0o644); err != nil {
		t.Fatal(err)
	}

	p, ok := reg.Resolve("core")
	if !ok {
		t.Fatal("expected to resolve builtin core")
	}
	if p.Source != state.SourceBuiltin || p.Approval != state.ApprovalApproved || !p.Enabled {
		t.Errorf("builtin should be approved+enabled, got %+v", p)
	}
	if p.Dir != dir {
		t.Errorf("dir = %q, want %q", p.Dir, dir)
	}
}

func TestResolveUnknown(t *testing.T) {
	reg, _, _, _ := newRegistry(t)
	if _, ok := reg.Resolve("nope"); ok {
		t.Errorf("expected miss for unknown plugin")
	}
}

func TestListBuiltins(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)

	for _, name := range []string{"alpha", "beta"} {
		dir := filepath.Join(builtinDir, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		m := fmt.Sprintf(`{"manifestVersion":3,"name":"%s","version":"1.0.0","type":"widget","label":"W","entry":"index.js","size":{"w":4,"h":3}}`, name)
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(m), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	plugins := reg.ListBuiltins()
	if len(plugins) != 2 {
		t.Fatalf("expected 2 builtins, got %d", len(plugins))
	}

	names := make(map[string]bool)
	for _, p := range plugins {
		names[p.Name] = true
		if p.Source != state.SourceBuiltin || p.Approval != state.ApprovalApproved || !p.Enabled {
			t.Errorf("builtin %s has wrong state: source=%s approval=%s enabled=%v", p.Name, p.Source, p.Approval, p.Enabled)
		}
	}

	if !names["alpha"] || !names["beta"] {
		t.Errorf("expected alpha and beta, got %v", names)
	}
}

func TestListBuiltinsIncludesDirectorySymlink(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)
	if err := os.MkdirAll(builtinDir, 0o755); err != nil {
		t.Fatal(err)
	}

	sourceDir := filepath.Join(t.TempDir(), "clients-widget")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"manifestVersion":3,"name":"clients-widget","version":"1.0.0","type":"widget","label":"Clients","entry":"index.js","size":{"w":4,"h":3}}`
	if err := os.WriteFile(filepath.Join(sourceDir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	linkPath := filepath.Join(builtinDir, "clients-widget")
	if err := os.Symlink(sourceDir, linkPath); err != nil {
		t.Fatal(err)
	}

	plugins := reg.ListBuiltins()
	if len(plugins) != 1 {
		t.Fatalf("expected 1 builtin, got %d", len(plugins))
	}
	if plugins[0].Name != "clients-widget" || plugins[0].Dir != linkPath {
		t.Errorf("unexpected symlinked builtin: %+v", plugins[0])
	}
}

func TestListBuiltinsSkipsInvalidManifest(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)

	goodDir := filepath.Join(builtinDir, "good")
	if err := os.MkdirAll(goodDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(goodDir, "manifest.json"), []byte(`{"manifestVersion":3,"name":"good","version":"1.0.0","type":"widget","label":"W","entry":"index.js","size":{"w":4,"h":3}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	badDir := filepath.Join(builtinDir, "bad")
	if err := os.MkdirAll(badDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "manifest.json"), []byte(`not json`), 0o644); err != nil {
		t.Fatal(err)
	}

	plugins := reg.ListBuiltins()
	if len(plugins) != 1 {
		t.Fatalf("expected 1 builtin (bad skipped), got %d", len(plugins))
	}
	if plugins[0].Name != "good" {
		t.Errorf("expected good, got %s", plugins[0].Name)
	}
}

func TestResolveTamperedManifestIsMiss(t *testing.T) {
	reg, store, _, _ := newRegistry(t)
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["bad"] = &state.Plugin{Name: "bad", Source: state.SourceUser, Approval: state.ApprovalApproved, Enabled: true, Manifest: json.RawMessage(`{"name":"bad"}`)}

		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok := reg.Resolve("bad"); ok {
		t.Errorf("a state entry with an invalid manifest must not resolve")
	}
}

func TestBackendServable(t *testing.T) {
	approvedEnabled := &Plugin{Approval: state.ApprovalApproved, Enabled: true}
	if err := approvedEnabled.BackendServable(); err != nil {
		t.Fatalf("approved+enabled should serve, got %v", err)
	}

	notApproved := &Plugin{Approval: state.ApprovalPending, Enabled: true}
	if err := notApproved.BackendServable(); err == nil || err.Status != http.StatusForbidden || err.Code != httpx.CodeNotApproved {
		t.Fatalf("pending plugin should be forbidden/not-approved, got %v", err)
	}

	disabled := &Plugin{Approval: state.ApprovalApproved, Enabled: false}
	if err := disabled.BackendServable(); err == nil || err.Status != http.StatusForbidden || err.Code != httpx.CodeDisabled {
		t.Fatalf("disabled plugin should be forbidden/disabled, got %v", err)
	}
}

func TestAllBackendPluginsMergesActiveUsersAndBuiltins(t *testing.T) {
	reg, store, _, builtinDir := newRegistry(t)
	writeRegistryBuiltin(t, builtinDir, "builtin-backend", registryBackendManifest("builtin-backend", false))
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["user-backend"] = registryStatePlugin("user-backend", state.ApprovalApproved, true, registryBackendManifest("user-backend", false))

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	plugins := reg.AllBackendPlugins()
	if len(plugins) != 2 {
		t.Fatalf("backend plugins = %d, want 2", len(plugins))
	}
	if got := plugins[0].Name; got != "user-backend" {
		t.Errorf("first backend plugin = %q, want user-backend", got)
	}
	if got := plugins[1].Name; got != "builtin-backend" {
		t.Errorf("second backend plugin = %q, want builtin-backend", got)
	}
}

func TestAllBackendPluginsReservesPendingAndDisabledNames(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		approval string
		enabled  bool
	}{
		{name: "pending", approval: state.ApprovalPending, enabled: false},
		{name: "disabled", approval: state.ApprovalApproved, enabled: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			reg, store, _, builtinDir := newRegistry(t)
			writeRegistryBuiltin(t, builtinDir, "collision", registryBackendManifest("collision", false))
			if err := store.Mutate(func(st *state.State) error {
				st.Plugins["collision"] = registryStatePlugin("collision", testCase.approval, testCase.enabled, registryBackendManifest("collision", false))

				return nil
			}); err != nil {
				t.Fatal(err)
			}

			if plugins := reg.AllBackendPlugins(); len(plugins) != 0 {
				t.Fatalf("backend plugins = %#v, want no collision builtin", plugins)
			}
		})
	}
}

func TestAllBackendPluginsSkipsInvalidAndNonBackendPlugins(t *testing.T) {
	reg, store, _, builtinDir := newRegistry(t)
	writeRegistryBuiltin(t, builtinDir, "builtin-page", registryPageManifest("builtin-page"))
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["invalid"] = registryStatePlugin("invalid", state.ApprovalApproved, true, `{"name":"invalid"}`)
		st.Plugins["page"] = registryStatePlugin("page", state.ApprovalApproved, true, registryPageManifest("page"))
		st.Plugins["pending"] = registryStatePlugin("pending", state.ApprovalPending, false, registryBackendManifest("pending", false))

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if plugins := reg.AllBackendPlugins(); len(plugins) != 0 {
		t.Fatalf("backend plugins = %#v, want none", plugins)
	}
}

func TestListBuiltinsWithErrorReportsUnreadableDirectory(t *testing.T) {
	reg, _, _, _ := newRegistry(t)
	file := filepath.Join(t.TempDir(), "builtin-file")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	reg.builtinDir = file

	if _, err := reg.ListBuiltinsWithError(); err == nil {
		t.Fatal("ListBuiltinsWithError succeeded for regular file")
	}
	if plugins := reg.ListBuiltins(); len(plugins) != 0 {
		t.Fatalf("best-effort builtins = %#v, want empty", plugins)
	}
}

func TestListBuiltinsWithErrorLogsInvalidManifest(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)
	var logs bytes.Buffer
	reg = NewWithLogger(reg.store, reg.userDir, reg.builtinDir, slog.New(slog.NewTextHandler(&logs, nil)))
	badDir := filepath.Join(builtinDir, "bad")
	if err := os.MkdirAll(badDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "manifest.json"), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := reg.ListBuiltinsWithError(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(logs.Bytes(), []byte("builtin plugin has invalid manifest, skipping")) {
		t.Fatalf("invalid-manifest warning missing: %s", logs.String())
	}
}

func writeRegistryBuiltin(t *testing.T, builtinDir, name, manifest string) {
	t.Helper()
	dir := filepath.Join(builtinDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

func registryStatePlugin(name, approval string, enabled bool, manifest string) *state.Plugin {
	return &state.Plugin{
		Name:     name,
		Source:   state.SourceUser,
		Approval: approval,
		Enabled:  enabled,
		Manifest: json.RawMessage(manifest),
	}
}

func registryPageManifest(name string) string {
	return fmt.Sprintf(`{"manifestVersion":3,"name":"%s","version":"1.0.0","type":"page","label":"%s","entry":"index.js","route":"/%s"}`, name, name, name)
}

func registryBackendManifest(name string, daemon bool) string {
	access := "session"
	if daemon {
		access = "public"
	}

	return fmt.Sprintf(`{"manifestVersion":3,"name":"%s","version":"1.0.0","type":"widget","label":"%s","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"exec","routes":[{"id":"run","transport":"http","method":"GET","path":"run","access":"%s","command":"backend/run.sh"}]}}`, name, name, access)
}
