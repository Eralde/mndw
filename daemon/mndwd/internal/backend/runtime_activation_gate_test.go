package backend

import (
	"encoding/json"
	"fmt"
	"testing"

	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestServiceSpecActivationGates(t *testing.T) {
	tests := []struct {
		name        string
		permissions []string
		registered  map[string]bool
		wantEnabled bool
	}{
		{name: "no gating permission", wantEnabled: true},
		{name: "missing registry entry is ignored", permissions: []string{manifest.PersistentRCISessionReadPermission}, registered: map[string]bool{"other:read": false}, wantEnabled: true},
		{name: "one satisfied gate", permissions: []string{manifest.PersistentRCISessionReadPermission}, registered: map[string]bool{manifest.PersistentRCISessionReadPermission: true}, wantEnabled: true},
		{name: "one unsatisfied gate", permissions: []string{manifest.PersistentRCISessionReadPermission}, registered: map[string]bool{manifest.PersistentRCISessionReadPermission: false}, wantEnabled: false},
		{name: "all gates satisfied", permissions: []string{manifest.PersistentRCISessionReadPermission, manifest.PersistentRCISessionWritePermission}, registered: map[string]bool{manifest.PersistentRCISessionReadPermission: true, manifest.PersistentRCISessionWritePermission: true}, wantEnabled: true},
		{name: "one of multiple gates unsatisfied", permissions: []string{manifest.PersistentRCISessionReadPermission, manifest.PersistentRCISessionWritePermission}, registered: map[string]bool{manifest.PersistentRCISessionReadPermission: true, manifest.PersistentRCISessionWritePermission: false}, wantEnabled: false},
		{name: "same predicate under read and write", permissions: []string{manifest.PersistentRCISessionReadPermission, manifest.PersistentRCISessionWritePermission}, registered: map[string]bool{manifest.PersistentRCISessionReadPermission: true, manifest.PersistentRCISessionWritePermission: true}, wantEnabled: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plugin := testServicePlugin(t, "demo", test.permissions, "backend/server", true)
			gates := NewActivationGateRegistry()

			for permission, satisfied := range test.registered {
				permission := permission
				satisfied := satisfied

				gates.Register(permission, ActivationGateFunc(func(_, permission string) []ActivationBlocker {
					if satisfied {
						return nil
					}

					return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
				}))
			}

			spec, ok := serviceSpec(plugin, gates)

			if !ok {
				t.Fatal("serviceSpec returned no service")
			}

			if spec.Enabled != test.wantEnabled {
				t.Fatalf("Enabled = %v, want %v", spec.Enabled, test.wantEnabled)
			}
		})
	}
}

func TestServiceSpecActivationGatesPreserveApprovalAndEnabledState(t *testing.T) {
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(_, _ string) []ActivationBlocker { return nil }))

	for _, test := range []struct {
		name     string
		approval state.Approval
		enabled  bool
	}{
		{name: "not approved", approval: state.ApprovalPending, enabled: true},
		{name: "disabled", approval: state.ApprovalApproved, enabled: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			plugin := testServicePlugin(t, "demo", []string{manifest.PersistentRCISessionReadPermission}, "backend/server", test.enabled)
			plugin.Approval = test.approval

			spec, ok := serviceSpec(plugin, gates)

			if !ok {
				t.Fatal("serviceSpec returned no service")
			}

			if spec.Enabled {
				t.Fatal("service remained enabled despite base lifecycle gate")
			}
		})
	}
}

func testServicePlugin(t *testing.T, name string, permissions []string, command string, enabled bool) *registry.Plugin {
	t.Helper()

	permissionJSON, err := json.Marshal(permissions)
	if err != nil {
		t.Fatal(err)
	}

	manifestJSON := fmt.Sprintf(`{"manifestVersion":3,"name":%q,"version":"1.0.0","type":"page","label":%q,"entry":"index.js","route":"/%s","permissions":%s,"backend":{"kind":"service","protocolVersion":1,"command":%q,"routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`, name, name, name, permissionJSON, command)
	parsed, err := manifest.ValidateV3([]byte(manifestJSON))
	if err != nil {
		t.Fatalf("validate test service manifest: %v", err)
	}

	return &registry.Plugin{
		Name:     name,
		Dir:      t.TempDir(),
		Manifest: parsed,
		Approval: state.ApprovalApproved,
		Enabled:  enabled,
	}
}
