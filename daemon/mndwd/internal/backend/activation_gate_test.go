package backend

import (
	"reflect"
	"testing"
)

func TestActivationGateRegistryLooksUpCapabilityIDs(t *testing.T) {
	gate := ActivationGate(func(pluginName, capability string) []ActivationBlocker {
		if pluginName == "ready" && capability == "capability:read" {
			return nil
		}

		return []ActivationBlocker{{Capability: capability, Reason: "not-granted"}}
	})
	registry := NewActivationGateRegistry()

	registry.Register("capability:read", gate)

	got, ok := registry.Lookup("capability:read")

	if !ok || len(got("ready", "capability:read")) != 0 || len(got("blocked", "capability:read")) == 0 {
		t.Fatalf("lookup = %#v, ok=%v", got, ok)
	}

	if _, ok := registry.Lookup("capability:write"); ok {
		t.Fatal("unregistered capability returned a gate")
	}
}

func TestActivationGateRegistryEvaluatesAllDeclaredCapabilitiesInOrder(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("capability:read", ActivationGate(func(_, capability string) []ActivationBlocker {
		return []ActivationBlocker{{Capability: capability, Reason: "not-granted"}, {Capability: capability, Reason: "not-granted"}}
	}))
	registry.Register("capability:write", ActivationGate(func(_, capability string) []ActivationBlocker {
		return []ActivationBlocker{{Capability: capability, Reason: "prerequisite-unavailable", Prerequisite: "controller-token"}}
	}))

	got := registry.Evaluate("demo", []string{"capability:read", "capability:write"})
	want := []ActivationBlocker{
		{Capability: "capability:read", Reason: "not-granted"},
		{Capability: "capability:write", Reason: "prerequisite-unavailable", Prerequisite: "controller-token"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Evaluate() = %#v, want %#v", got, want)
	}
}

func TestActivationGateRegistryDeduplicatesBlockersAndIgnoresMissingGates(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("capability:read", ActivationGate(func(_, capability string) []ActivationBlocker {
		return []ActivationBlocker{
			{Capability: capability, Reason: "not-granted"},
			{Capability: capability, Reason: "not-granted"},
		}
	}))

	got := registry.Evaluate("demo", []string{"capability:read", "capability:missing", "capability:read"})
	want := []ActivationBlocker{{Capability: "capability:read", Reason: "not-granted"}}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Evaluate() = %#v, want %#v", got, want)
	}
}

func TestActivationGateRegistrySatisfiedUsesStructuredEvaluation(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("capability:read", ActivationGate(func(_, capability string) []ActivationBlocker {
		return []ActivationBlocker{{Capability: capability, Reason: "not-granted"}}
	}))

	if registry.Satisfied("demo", []string{"capability:missing"}) != true {
		t.Fatal("missing gate should not block service")
	}

	if registry.Satisfied("demo", []string{"capability:read"}) {
		t.Fatal("active blocker reported satisfied")
	}
}

func TestActivationGateRegistryNilLookupIsMissing(t *testing.T) {
	var registry *ActivationGateRegistry

	if _, ok := registry.Lookup("capability:read"); ok {
		t.Fatal("nil registry returned a gate")
	}
}

func TestActivationGateCallPreservesBlockerResults(t *testing.T) {
	gate := ActivationGate(func(pluginName, capability string) []ActivationBlocker {
		if pluginName == "demo" && capability == "capability:read" {
			return nil
		}

		return []ActivationBlocker{{Capability: capability, Reason: "not-granted"}}
	})

	if len(gate("demo", "capability:read")) != 0 || len(gate("other", "capability:read")) == 0 {
		t.Fatal("function adapter returned unexpected satisfaction")
	}
}
