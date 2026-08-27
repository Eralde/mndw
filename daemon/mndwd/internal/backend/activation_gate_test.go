package backend

import (
	"reflect"
	"testing"
)

func TestActivationGateRegistryLooksUpPermissionIDs(t *testing.T) {
	gate := ActivationGateFunc(func(pluginName, permission string) []ActivationBlocker {
		if pluginName == "ready" && permission == "permission:read" {
			return nil
		}

		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
	})
	registry := NewActivationGateRegistry()

	registry.Register("permission:read", gate)

	got, ok := registry.Lookup("permission:read")

	if !ok || len(got.Evaluate("ready", "permission:read")) != 0 || len(got.Evaluate("blocked", "permission:read")) == 0 {
		t.Fatalf("lookup = %#v, ok=%v", got, ok)
	}

	if _, ok := registry.Lookup("permission:write"); ok {
		t.Fatal("unregistered permission returned a gate")
	}
}

func TestActivationGateRegistryEvaluatesAllDeclaredPermissionsInOrder(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("permission:read", ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}, {Permission: permission, Reason: "not-granted"}}
	}))
	registry.Register("permission:write", ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{{Permission: permission, Reason: "prerequisite-unavailable", Prerequisite: "controller-token"}}
	}))

	got := registry.Evaluate("demo", []string{"permission:read", "permission:write"})
	want := []ActivationBlocker{
		{Permission: "permission:read", Reason: "not-granted"},
		{Permission: "permission:write", Reason: "prerequisite-unavailable", Prerequisite: "controller-token"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Evaluate() = %#v, want %#v", got, want)
	}
}

func TestActivationGateRegistryDeduplicatesBlockersAndIgnoresMissingGates(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("permission:read", ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{
			{Permission: permission, Reason: "not-granted"},
			{Permission: permission, Reason: "not-granted"},
		}
	}))

	got := registry.Evaluate("demo", []string{"permission:read", "permission:missing", "permission:read"})
	want := []ActivationBlocker{{Permission: "permission:read", Reason: "not-granted"}}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Evaluate() = %#v, want %#v", got, want)
	}
}

func TestActivationGateRegistrySatisfiedUsesStructuredEvaluation(t *testing.T) {
	registry := NewActivationGateRegistry()

	registry.Register("permission:read", ActivationGateFunc(func(_, permission string) []ActivationBlocker {
		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
	}))

	if registry.Satisfied("demo", []string{"permission:missing"}) != true {
		t.Fatal("missing gate should not block service")
	}

	if registry.Satisfied("demo", []string{"permission:read"}) {
		t.Fatal("active blocker reported satisfied")
	}
}

func TestActivationGateRegistryNilLookupIsMissing(t *testing.T) {
	var registry *ActivationGateRegistry

	if _, ok := registry.Lookup("permission:read"); ok {
		t.Fatal("nil registry returned a gate")
	}
}

func TestActivationGateFuncImplementsActivationGate(t *testing.T) {
	var gate ActivationGate = ActivationGateFunc(func(pluginName, permission string) []ActivationBlocker {
		if pluginName == "demo" && permission == "permission:read" {
			return nil
		}

		return []ActivationBlocker{{Permission: permission, Reason: "not-granted"}}
	})

	if len(gate.Evaluate("demo", "permission:read")) != 0 || len(gate.Evaluate("other", "permission:read")) == 0 {
		t.Fatal("function adapter returned unexpected satisfaction")
	}
}
