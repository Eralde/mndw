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
		name         string
		capabilities []string
		registered   map[string]bool
		wantEnabled  bool
	}{
		{name: "no gating capability", wantEnabled: true},
		{name: "missing registry entry is ignored", capabilities: []string{manifest.PersistentRCISessionReadCapability}, registered: map[string]bool{"other:read": false}, wantEnabled: true},
		{name: "one satisfied gate", capabilities: []string{manifest.PersistentRCISessionReadCapability}, registered: map[string]bool{manifest.PersistentRCISessionReadCapability: true}, wantEnabled: true},
		{name: "one unsatisfied gate", capabilities: []string{manifest.PersistentRCISessionReadCapability}, registered: map[string]bool{manifest.PersistentRCISessionReadCapability: false}, wantEnabled: false},
		{name: "all gates satisfied", capabilities: []string{manifest.PersistentRCISessionReadCapability, manifest.PersistentRCISessionWriteCapability}, registered: map[string]bool{manifest.PersistentRCISessionReadCapability: true, manifest.PersistentRCISessionWriteCapability: true}, wantEnabled: true},
		{name: "one of multiple gates unsatisfied", capabilities: []string{manifest.PersistentRCISessionReadCapability, manifest.PersistentRCISessionWriteCapability}, registered: map[string]bool{manifest.PersistentRCISessionReadCapability: true, manifest.PersistentRCISessionWriteCapability: false}, wantEnabled: false},
		{name: "same predicate under read and write", capabilities: []string{manifest.PersistentRCISessionReadCapability, manifest.PersistentRCISessionWriteCapability}, registered: map[string]bool{manifest.PersistentRCISessionReadCapability: true, manifest.PersistentRCISessionWriteCapability: true}, wantEnabled: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plugin := testServicePlugin(t, "demo", test.capabilities, "backend/server", true)
			gates := NewActivationGateRegistry()

			for capability, satisfied := range test.registered {
				capability := capability
				satisfied := satisfied

				gates.Register(capability, ActivationGate(func(_, capability string) []ActivationBlocker {
					if satisfied {
						return nil
					}

					return []ActivationBlocker{{Capability: capability, Reason: "not-granted"}}
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

	gates.Register(manifest.PersistentRCISessionReadCapability, ActivationGate(func(_, _ string) []ActivationBlocker { return nil }))

	for _, test := range []struct {
		name     string
		approval state.Approval
		enabled  bool
	}{
		{name: "not approved", approval: state.ApprovalPending, enabled: true},
		{name: "disabled", approval: state.ApprovalApproved, enabled: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			plugin := testServicePlugin(t, "demo", []string{manifest.PersistentRCISessionReadCapability}, "backend/server", test.enabled)
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

func testServicePlugin(t *testing.T, name string, capabilities []string, command string, enabled bool) *registry.Plugin {
	t.Helper()

	capabilityJSON, err := json.Marshal(capabilities)
	if err != nil {
		t.Fatal(err)
	}

	manifestJSON := fmt.Sprintf(`{"manifestVersion":1,"name":%q,"version":"1.0.0","type":"page","label":%q,"entry":"index.js","route":"/%s","capabilities":%s,"backend":{"kind":"service","protocolVersion":1,"command":%q,"routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`, name, name, name, capabilityJSON, command)
	parsed, err := manifest.Validate([]byte(manifestJSON))
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
