package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestLinuxRealBackendLifecycle(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("real backend lifecycle requires Linux process-group and /proc semantics")
	}

	root := t.TempDir()
	userDir := filepath.Join(root, "plugins")

	if err := os.MkdirAll(userDir, 0o700); err != nil {
		t.Fatal(err)
	}

	serviceDir := filepath.Join(userDir, "service")
	execDir := filepath.Join(userDir, "exec")

	for _, dir := range []string{serviceDir, execDir} {
		if err := os.MkdirAll(filepath.Join(dir, "backend"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	serviceBinary := filepath.Join(serviceDir, "backend", "service-helper")

	buildServiceHelper(t, serviceBinary)

	if err := os.WriteFile(filepath.Join(execDir, "backend", "echo.cgi"), []byte("#!/bin/sh\nprintf 'Content-Type: text/plain\\n\\n'\nprintf '%s|%s|%s' \"$REQUEST_METHOD\" \"$QUERY_STRING\" \"$(cat)\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	serviceManifest := []byte(`{"manifestVersion":1,"name":"service","version":"1.0.0","type":"page","label":"Service","entry":"index.js","route":"/service","backend":{"kind":"service","protocolVersion":1,"command":"backend/service-helper","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`)
	execManifest := []byte(`{"manifestVersion":1,"name":"exec","version":"1.0.0","type":"page","label":"Exec","entry":"index.js","route":"/exec","backend":{"kind":"exec","routes":[{"id":"echo","transport":"http","method":"POST","path":"echo","command":"backend/echo.cgi"}]}}`)
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["service"] = &state.Plugin{Name: "service", Source: state.SourceUpload, Version: "1.0.0", Type: "page", Label: "Service", Approval: state.ApprovalApproved, Enabled: true, Manifest: serviceManifest}
		st.Plugins["exec"] = &state.Plugin{Name: "exec", Source: state.SourceUpload, Version: "1.0.0", Type: "page", Label: "Exec", Approval: state.ApprovalApproved, Enabled: true, Manifest: execManifest}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	reg := registry.New(store, userDir, "")
	servicePlugin, ok := reg.Resolve("service")

	if !ok {
		t.Fatal("service plugin did not resolve")
	}

	execPlugin, ok := reg.Resolve("exec")

	if !ok {
		t.Fatal("exec plugin did not resolve")
	}

	runtimeRoot := filepath.Join(root, "plugin-runtime")
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot:    runtimeRoot,
		PluginDataRoot: filepath.Join(root, "plugin-data"),
		Limits:         Limits{MaxConcurrentExecTotal: 2, MaxConcurrentExecPerPlugin: 1, MaxSupervisedServices: 1},
		Exec: ExecRunnerConfig{
			Timeout:        2 * time.Second,
			KillGrace:      100 * time.Millisecond,
			MaxBodyBytes:   1024,
			MaxOutputBytes: 4096,
		},
		Supervisor: SupervisorConfig{ReadinessTimeout: 2 * time.Second, StopTimeout: 2 * time.Second, FinalReapTimeout: time.Second},
	})

	defer func() { _ = runtime.Shutdown(context.Background()) }()

	runtime.Reconcile(context.Background(), []*registry.Plugin{execPlugin, servicePlugin})

	if status := runtime.Status("service"); status.State != StateReady {
		t.Fatalf("service status = %+v", status)
	}

	mux := http.NewServeMux()
	gateway := NewGateway(GatewayConfig{MaxRequestBytes: 1024, ServiceHTTPTimeout: 2 * time.Second}, reg, nil, runtime.ExecRunner(), runtime.Supervisor(), nil)

	gateway.Register(mux)

	execRequest := httptest.NewRequest(http.MethodPost, "/api/plugins/exec/echo?q=1", bytes.NewBufferString("body"))

	execRequest.Header.Set("Content-Type", "text/plain")

	execRecorder := httptest.NewRecorder()

	mux.ServeHTTP(execRecorder, execRequest)

	if execRecorder.Code != http.StatusOK || strings.TrimSpace(execRecorder.Body.String()) != "POST|q=1|body" {
		t.Fatalf("exec response = %d %q", execRecorder.Code, execRecorder.Body.String())
	}

	serviceRequest := httptest.NewRequest(http.MethodGet, "/api/plugins/service/status", nil)
	serviceRecorder := httptest.NewRecorder()

	mux.ServeHTTP(serviceRecorder, serviceRequest)

	if serviceRecorder.Code != http.StatusOK {
		t.Fatalf("service response = %d %q", serviceRecorder.Code, serviceRecorder.Body.String())
	}

	var serviceResponse map[string]any

	if err := json.Unmarshal(serviceRecorder.Body.Bytes(), &serviceResponse); err != nil {
		t.Fatal(err)
	}

	if serviceResponse["pluginId"] != "service" {
		t.Fatalf("service response = %#v", serviceResponse)
	}

	paths, err := NewRuntimePaths(runtimeRoot, "service")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.BackendSocket); err != nil {
		t.Fatalf("backend socket missing: %v", err)
	}

	if _, err := os.Stat(paths.ServiceLease); err != nil {
		t.Fatalf("service lease missing: %v", err)
	}

	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.BackendSocket); !os.IsNotExist(err) {
		t.Fatalf("backend socket after shutdown: %v", err)
	}

	if _, err := os.Stat(paths.ServiceLease); !os.IsNotExist(err) {
		t.Fatalf("service lease after shutdown: %v", err)
	}
}

func buildServiceHelper(t *testing.T, output string) {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)

	if !ok {
		t.Fatal("runtime.Caller failed")
	}

	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
	command := exec.Command("go", "build", "-o", output, "./internal/backend/testdata/service-helper")
	command.Dir = moduleRoot

	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build service helper: %v\n%s", err, output)
	}
}
