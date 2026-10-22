package main

import (
	"context"
	"testing"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/telemetry"
)

func TestNewControllerRCIClientCreatesFreshClients(t *testing.T) {
	do := func(_ context.Context, _ proxy.Request) (proxy.Response, error) {
		return proxy.Response{Status: 200, Body: []byte(`[{}]`)}, nil
	}

	telemetryClient, err := newControllerRCIClient(telemetry.DoFunc(do))
	if err != nil {
		t.Fatal(err)
	}

	eventClient, err := newControllerRCIClient(telemetry.DoFunc(do))
	if err != nil {
		t.Fatal(err)
	}

	if telemetryClient == nil || eventClient == nil {
		t.Fatal("expected clients")
	}

	if telemetryClient == eventClient {
		t.Fatal("separate client constructions must return distinct clients")
	}

	var _ *rci.Client = telemetryClient
}
