package backend

import "testing"

func TestActivationGateRegistryLooksUpPermissionIDs(t *testing.T) {
	gate := ActivationGateFunc(func(pluginName string) bool { return pluginName == "ready" })
	registry := NewActivationGateRegistry()

	registry.Register("permission:read", gate)

	got, ok := registry.Lookup("permission:read")

	if !ok || !got.Satisfied("ready") || got.Satisfied("blocked") {
		t.Fatalf("lookup = %#v, ok=%v", got, ok)
	}

	if _, ok := registry.Lookup("permission:write"); ok {
		t.Fatal("unregistered permission returned a gate")
	}
}

func TestActivationGateRegistryNilLookupIsMissing(t *testing.T) {
	var registry *ActivationGateRegistry

	if _, ok := registry.Lookup("permission:read"); ok {
		t.Fatal("nil registry returned a gate")
	}
}

func TestActivationGateFuncImplementsActivationGate(t *testing.T) {
	var gate ActivationGate = ActivationGateFunc(func(pluginName string) bool { return pluginName == "demo" })

	if !gate.Satisfied("demo") || gate.Satisfied("other") {
		t.Fatal("function adapter returned unexpected satisfaction")
	}
}
