package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"mndwd/internal/diagnostics"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestDiagnosticsPluginsEnumeratesApprovedEnabledBackends(t *testing.T) {
	root := t.TempDir()
	userDir := filepath.Join(root, "user-plugins")
	builtinDir := filepath.Join(root, "builtin-plugins")
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha", "duplicate"} {
		dir := filepath.Join(builtinDir, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), testManifest(name, true, name == "alpha"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["z-user"] = &state.Plugin{Name: "z-user", Approval: state.ApprovalApproved, Enabled: true, Manifest: testManifest("z-user", true, true)}
		st.Plugins["duplicate"] = &state.Plugin{Name: "duplicate", Approval: state.ApprovalApproved, Enabled: true, Manifest: testManifest("duplicate", true, false)}
		st.Plugins["disabled"] = &state.Plugin{Name: "disabled", Approval: state.ApprovalApproved, Enabled: false, Manifest: testManifest("disabled", true, true)}
		st.Plugins["pending"] = &state.Plugin{Name: "pending", Approval: state.ApprovalPending, Enabled: true, Manifest: testManifest("pending", true, true)}
		st.Plugins["plain"] = &state.Plugin{Name: "plain", Approval: state.ApprovalApproved, Enabled: true, Manifest: testManifest("plain", false, false)}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	reg := registry.New(store, userDir, builtinDir)
	got := diagnosticsPlugins(reg, store, filepath.Join(root, "runtime"))
	wantIDs := []string{"alpha", "duplicate", "z-user"}
	if ids := diagnosticPluginIDs(got); !reflect.DeepEqual(ids, wantIDs) {
		t.Fatalf("plugin IDs = %#v, want %#v", ids, wantIDs)
	}
	for _, plugin := range got {
		if plugin.RuntimeDir != filepath.Join(root, "runtime", plugin.ID) {
			t.Fatalf("plugin %s runtime dir = %q", plugin.ID, plugin.RuntimeDir)
		}
	}
	if got := diagnosticsPlugins(reg, store, ""); len(got) != 0 {
		t.Fatalf("empty runtime root produced plugins = %#v", got)
	}
}

func diagnosticPluginIDs(plugins []diagnostics.Plugin) []string {
	ids := make([]string, 0, len(plugins))
	for _, plugin := range plugins {
		ids = append(ids, plugin.ID)
	}
	return ids
}

func testManifest(name string, backend, daemon bool) json.RawMessage {
	backendJSON := ""
	if backend {
		backendJSON = `,"backend":{"public":true}`
		if daemon {
			backendJSON = `,"backend":{"public":true,"daemon":{"start":"backend/start.sh","stop":"backend/stop.sh"}}`
		}
	}
	return json.RawMessage(fmt.Sprintf(`{"manifestVersion":2,"name":"%s","version":"1.0.0","type":"widget","label":"%s","entry":"index.js","size":{"w":4,"h":3}%s}`, name, name, backendJSON))
}
