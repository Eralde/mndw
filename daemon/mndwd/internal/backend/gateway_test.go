package backend

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"mndwd/internal/httpx"
)

func TestCanonicalRoutePathRejectsReservedAndNonCanonicalPaths(t *testing.T) {
	for _, path := range []string{"_mndw/ready", "%5Fmndw/ready", "a//b", "a/./b", "a/../b", "a\\b", "a%252Fb"} {
		if _, ok := CanonicalRoutePath(path); ok {
			t.Errorf("CanonicalRoutePath(%q) accepted", path)
		}
	}

	for _, path := range []string{"status", "api/v1/status"} {
		if got, ok := CanonicalRoutePath(path); !ok || got != path {
			t.Errorf("CanonicalRoutePath(%q) = %q, %v", path, got, ok)
		}
	}
}

func TestNoCORSResponseWriterRemovesInternalHeaders(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := httpx.NewNoCORSResponseWriter(recorder)

	writer.Header().Set("Access-Control-Allow-Origin", "*")
	writer.Header().Set("X-Allowed", "yes")
	writer.WriteHeader(http.StatusOK)

	if recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS header survived response boundary")
	}

	if recorder.Header().Get("X-Allowed") != "yes" {
		t.Fatal("safe response header was removed")
	}
}

func TestGatewayMaintenanceGateHasPluginAndPlatformScopes(t *testing.T) {
	gateway := NewGateway(GatewayConfig{}, nil, nil, nil, nil, nil)

	if gateway.isMaintenance("demo") {
		t.Fatal("fresh gateway is in maintenance")
	}

	gateway.BeginPluginMaintenance("demo")

	if !gateway.isMaintenance("demo") || gateway.isMaintenance("other") {
		t.Fatal("plugin maintenance scope is incorrect")
	}

	gateway.EndPluginMaintenance("demo")

	if gateway.isMaintenance("demo") {
		t.Fatal("plugin maintenance did not end")
	}

	gateway.BeginPlatformMaintenance()

	if !gateway.isMaintenance("demo") || !gateway.isMaintenance("other") {
		t.Fatal("platform maintenance scope is incorrect")
	}
}
