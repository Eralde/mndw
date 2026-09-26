package main

import "testing"

func TestAuthenticatorOrNil(t *testing.T) {
	if auth := authenticatorOrNil(nil); auth != nil {
		t.Fatalf("authenticatorOrNil(nil) = %#v, want a nil interface so the gateway skips authentication", auth)
	}
}

func TestTelemetryControllerOrNil(t *testing.T) {
	if controller := telemetryControllerOrNil(nil); controller != nil {
		t.Fatalf("telemetryControllerOrNil(nil) = %#v, want a nil interface so mgmt reports telemetry unavailable", controller)
	}
}
