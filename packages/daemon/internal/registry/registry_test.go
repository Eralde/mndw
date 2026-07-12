package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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
	m := `{"manifestVersion":2,"name":"svc","version":"1.0.0","type":"widget","label":"W","entry":"index.js","size":{"w":4,"h":3},"backend":{"public":true}}`
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
	if !p.Public() {
		t.Errorf("expected public true")
	}
}

func TestResolveBuiltin(t *testing.T) {
	reg, _, _, builtinDir := newRegistry(t)
	dir := filepath.Join(builtinDir, "core")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	m := `{"manifestVersion":2,"name":"core","version":"2.0.0","type":"page","label":"C","entry":"index.js","route":"/core"}`
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
