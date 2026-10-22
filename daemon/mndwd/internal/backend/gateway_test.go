package backend

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestCanonicalRoutePathRejectsReservedAndNonCanonicalPaths(t *testing.T) {
	for _, path := range []string{"_mndw/ready", "_mndw/status", "%5Fmndw/ready", "a//b", "a/./b", "a/../b", "a\\b", "a%252Fb"} {
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

func TestSupportsProtocolUsesConfiguredStaticMembership(t *testing.T) {
	for _, test := range []struct {
		name      string
		required  int
		supported []int
		want      bool
	}{
		{name: "configured", required: 2, supported: []int{1, 2}, want: true},
		{name: "unsupported", required: 2, supported: []int{1}, want: false},
		{name: "default protocol", required: 1, supported: nil, want: true},
		{name: "empty does not support other", required: 2, supported: nil, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := supportsProtocol(test.required, test.supported); got != test.want {
				t.Fatalf("supportsProtocol() = %v, want %v", got, test.want)
			}
		})
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

func TestGatewayMaintenanceGateUsesRuntimeBlockAndPlatformScope(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	gateway := NewGateway(GatewayConfig{}, nil, nil, runtime, nil)

	if gateway.isMaintenance("demo") {
		t.Fatal("fresh gateway is in maintenance")
	}

	setTrafficBlockedForTest(runtime, "demo", true)

	if !gateway.isMaintenance("demo") || gateway.isMaintenance("other") {
		t.Fatal("plugin maintenance scope is incorrect")
	}

	gateway.traffic.BeginPlatformMaintenance()

	if !gateway.isMaintenance("demo") || !gateway.isMaintenance("other") {
		t.Fatal("platform maintenance scope is incorrect")
	}
}

func TestGatewayAdmitWebSocketRefusesBlockedPlugin(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	gateway := &Gateway{runtime: runtime, traffic: runtime.Traffic()}

	setTrafficBlockedForTest(runtime, "p", true)

	refusedCloser := &recordingCloser{}

	if _, ok := gateway.admitWebSocket(refusedCloser, "p"); ok {
		t.Fatal("admitWebSocket accepted a blocked plugin")
	}

	if got := refusedCloser.closeRecords(); len(got) != 1 || got[0] != (recordedClose{code: websocket.StatusServiceRestart, reason: "mndw updating"}) {
		t.Fatalf("refused close records = %#v, want one service-restart close", got)
	}

	runtime.Traffic().ClosePlugin("p")

	if got := refusedCloser.closeRecords(); len(got) != 1 {
		t.Fatalf("refused close records after ClosePlugin = %#v, want one close", got)
	}

	setTrafficBlockedForTest(runtime, "p", false)

	acceptedCloser := &recordingCloser{}
	untrack, ok := gateway.admitWebSocket(acceptedCloser, "p")

	if !ok {
		t.Fatal("admitWebSocket refused an unblocked plugin")
	}

	untrack()
}

func TestGatewayDevValidationAllowsSymlinkedBuiltinRoot(t *testing.T) {
	sourceDir := t.TempDir()
	pluginRoot := t.TempDir()
	commandDir := filepath.Join(sourceDir, "backend")
	command := filepath.Join(commandDir, "command.sh")

	if err := os.Mkdir(commandDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(command, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	symlinkedPlugin := filepath.Join(pluginRoot, "sample")

	if err := os.Symlink(sourceDir, symlinkedPlugin); err != nil {
		t.Fatal(err)
	}

	plugin := &registry.Plugin{Dir: symlinkedPlugin, Source: state.SourceBuiltin}
	dev := NewGateway(GatewayConfig{AllowSymlinkedBuiltinRoot: true}, nil, nil, nil, nil)

	if _, err := dev.validateCommand(plugin, "backend/command.sh"); err != nil {
		t.Fatalf("dev exec validation rejected a symlinked builtin root: %v", err)
	}

	user := &registry.Plugin{Dir: symlinkedPlugin, Source: state.SourceUpload}

	if _, err := dev.validateCommand(user, "backend/command.sh"); err == nil {
		t.Fatal("dev exec validation accepted a symlinked user plugin root")
	}
}
