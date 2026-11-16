package backend

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestGatewayServiceBodyTimeoutAndBodyEOFDeadline(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "mndw-")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove test root: %v", err)
		}
	})

	userDir := filepath.Join(root, "plugins")
	pluginDir := filepath.Join(userDir, "service")
	backendDir := filepath.Join(pluginDir, "backend")

	if err := os.MkdirAll(backendDir, 0o700); err != nil {
		t.Fatal(err)
	}

	serviceBinary := filepath.Join(backendDir, "service-helper")

	buildServiceHelper(t, serviceBinary)

	manifest := json.RawMessage(`{"manifestVersion":1,"name":"service","version":"1.0.0","type":"page","label":"Service","entry":"index.js","route":"/service","backend":{"kind":"service","protocolVersion":1,"command":"backend/service-helper","routes":[{"id":"consume","transport":"http","method":"POST","path":"consume"},{"id":"slow","transport":"http","method":"POST","path":"slow"}]}}`)
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["service"] = &state.Plugin{
			Name:     "service",
			Source:   state.SourceUpload,
			Version:  "1.0.0",
			Type:     "page",
			Label:    "Service",
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: manifest,
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	reg := registry.NewWithLogger(store, userDir, "", nil)
	plugin, ok := reg.Resolve("service")

	if !ok {
		t.Fatal("service plugin did not resolve")
	}

	runtimeRoot := filepath.Join(root, "runtime")
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: runtimeRoot,
		Supervisor: SupervisorConfig{
			ReadinessTimeout: 2 * time.Second,
			StopTimeout:      2 * time.Second,
			FinalReapTimeout: time.Second,
		},
	})

	t.Cleanup(func() {
		if err := runtime.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown runtime: %v", err)
		}
	})
	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForServiceState(t, runtime, "service", StateReady, 5*time.Second)

	mux := http.NewServeMux()

	NewGateway(GatewayConfig{BodyReadTimeout: 80 * time.Millisecond, ServiceHTTPTimeout: 2 * time.Second}, reg, nil, runtime, nil).Register(mux)

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on IPv4 loopback: %v", err)
	}

	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: mux}}

	server.Start()
	t.Cleanup(server.Close)

	response := sendPartialBodyRequest(t, server, http.MethodPost, "/api/plugins/service/consume", 10, "x", time.Second)

	defer response.Body.Close()

	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusRequestTimeout || payload.Error.Code != httpx.CodeRequestTimeout {
		t.Fatalf("service body timeout = %d %q, want 408 %q", response.StatusCode, payload.Error.Code, httpx.CodeRequestTimeout)
	}

	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/plugins/service/consume", strings.NewReader("whole-body"))
	if err != nil {
		t.Fatal(err)
	}

	request.Header.Set("X-Mndw-Csrf", "1")

	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	forwardedBody, err := io.ReadAll(response.Body)

	response.Body.Close()

	if err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusOK || string(forwardedBody) != "whole-body" {
		t.Fatalf("service forwarded body = status %d, body %q; want 200 and %q", response.StatusCode, forwardedBody, "whole-body")
	}

	request, err = http.NewRequest(http.MethodPost, server.URL+"/api/plugins/service/slow", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}

	request.Header.Set("X-Mndw-Csrf", "1")

	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)

		t.Fatalf("service response after body EOF = %d, want 200; body = %s", response.StatusCode, body)
	}
}
