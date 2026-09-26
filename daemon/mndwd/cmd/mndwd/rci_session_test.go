package main

import (
	"context"
	"testing"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/telemetry"
)

func TestNewTelemetryAndEventClientsUseDistinctClients(t *testing.T) {
	do := func(_ context.Context, _ proxy.Request) (proxy.Response, error) {
		return proxy.Response{Status: 200, Body: []byte(`[{}]`)}, nil
	}

	telemetryClient, eventClient, err := newTelemetryAndEventClients(telemetry.DoFunc(do))
	if err != nil {
		t.Fatal(err)
	}

	if telemetryClient == nil || eventClient == nil {
		t.Fatal("expected both clients")
	}

	if telemetryClient == eventClient {
		t.Fatal("telemetry and event clients must be distinct")
	}

	var _ *rci.Client = telemetryClient
}
