package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/coordinator"
	"mndwd/internal/rcisession/model"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestAssembleActivationGateStartupAndSynchronousControllerPoke(t *testing.T) {
	if !unixSocketAvailable(t) {
		return
	}

	fixture := newActivationIntegrationFixture(t, false)

	if len(fixture.assembly.ActivationBlockers("demo", manifest.PersistentRCISessionWritePermission)) == 0 {
		t.Fatal("initial assembly satisfied gate without controller token")
	}

	fixture.runtime.Reconcile(context.Background(), fixture.registryPlugins())

	if status := fixture.runtime.Status("demo"); status.State != backend.StateStopped {
		t.Fatalf("initial reconcile without token = %q, want stopped", status.State)
	}

	if status := readGatewayStatus(t, fixture); status.State != "blocked" || len(status.Blockers) != 2 {
		t.Fatalf("initial status = %#v, want blocked with two blockers", status)
	}

	fixture = newActivationIntegrationFixture(t, true)

	if len(fixture.assembly.ActivationBlockers("demo", manifest.PersistentRCISessionWritePermission)) != 0 {
		t.Fatal("initial assembly did not publish granted controller-token snapshot")
	}

	fixture.runtime.Reconcile(context.Background(), fixture.registryPlugins())

	waitForRuntimeState(t, fixture.runtime, "demo", backend.StateReady)

	if status := readGatewayStatus(t, fixture); status.State != "ready" {
		t.Fatalf("ready status = %#v, want ready", status)
	}

	var pokes atomic.Int32

	fixture.assembly.SetActivationPoke(func() {
		pokes.Add(1)
		fixture.runtime.Reconcile(context.Background(), fixture.registryPlugins())
	})

	tester := &activationControllerTester{}
	mux := http.NewServeMux()

	rcisession.NewHandler(fixture.assembly.Service(), tester, nil).Register(mux)

	deleteController(t, mux)

	if got := pokes.Load(); got != 1 {
		t.Fatalf("controller deletion pokes = %d, want synchronous 1", got)
	}

	waitForReservedServices(t, fixture.runtime, 0)

	if status := fixture.runtime.Status("demo"); status.State != backend.StateStopped {
		t.Fatalf("after delete = %q, want stopped", status.State)
	}

	if status := readGatewayStatus(t, fixture); status.State != "blocked" {
		t.Fatalf("blocked status after delete = %#v, want blocked", status)
	}

	if got := fixture.runtime.Limits().ReservedServices; got != 0 {
		t.Fatalf("reserved services while gated off = %d, want 0", got)
	}

	saveController(t, mux, "controller-token")

	if got := pokes.Load(); got != 2 {
		t.Fatalf("controller save pokes = %d, want synchronous 2", got)
	}

	waitForRuntimeState(t, fixture.runtime, "demo", backend.StateReady)

	if got := tester.calls.Load(); got != 1 {
		t.Fatalf("controller tester calls = %d, want 1", got)
	}

	fixture.assembly.Service().Unauthorized("controller", fixture.assembly.Service().ControllerEpoch())
	fixture.assembly.Service().Unauthorized("controller", fixture.assembly.Service().ControllerEpoch())

	if got := pokes.Load(); got != 2 {
		t.Fatalf("retained-token Unauthorized pokes = %d, want 2", got)
	}

	if err := fixture.store.SetGrant("demo", manifest.PersistentRCISessionWritePermission, false); err != nil {
		t.Fatalf("disable grant: %v", err)
	}

	if err := fixture.assembly.PermissionChanged("demo"); err != nil {
		t.Fatalf("PermissionChanged after grant disable: %v", err)
	}

	waitForRuntimeState(t, fixture.runtime, "demo", backend.StateStopped)
	waitForReservedServices(t, fixture.runtime, 0)

	if err := fixture.store.SetGrant("demo", manifest.PersistentRCISessionWritePermission, true); err != nil {
		t.Fatalf("enable grant: %v", err)
	}

	if err := fixture.assembly.PermissionChanged("demo"); err != nil {
		t.Fatalf("PermissionChanged after grant enable: %v", err)
	}

	waitForRuntimeState(t, fixture.runtime, "demo", backend.StateReady)
}

type activationIntegrationFixture struct {
	store    *state.Store
	registry *registry.Registry
	runtime  *backend.RuntimeImpl
	assembly *coordinator.Coordinator
	gateway  *backend.Gateway
	mux      *http.ServeMux
}

func newActivationIntegrationFixture(t *testing.T, withToken bool) *activationIntegrationFixture {
	t.Helper()

	root := shortTempDir(t)
	cfg := Config{
		DataDir:                    filepath.Join(root, "data"),
		RCISessionStateDir:         filepath.Join(root, "rci"),
		RCISessionKeyDir:           filepath.Join(root, "rci-secrets"),
		PluginRuntimeRoot:          filepath.Join(root, "runtime"),
		BuiltinPluginsDir:          filepath.Join(root, "builtins"),
		UserPluginsDir:             filepath.Join(root, "plugins"),
		DeviceURL:                  "http://127.0.0.1:80",
		ControllerURL:              rcisession.DefaultControllerURL,
		Dev:                        true,
		Opkg:                       "stub",
		ExecTimeout:                time.Second,
		ServiceHTTPTimeout:         time.Second,
		ServiceStopTimeout:         time.Second,
		FinalReapTimeout:           time.Second,
		RCIProxyOperationTimeout:   time.Second,
		RCIProxyMaxResponseBytes:   1 << 20,
		MaxConcurrentExecTotal:     1,
		MaxConcurrentExecPerPlugin: 1,
		MaxSupervisedServices:      1,
		SupportedServiceProtocols:  []int{1},
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	pluginDir := filepath.Join(cfg.UserPluginsDir, "demo")

	if err := os.MkdirAll(filepath.Join(pluginDir, "backend"), 0o700); err != nil {
		t.Fatalf("create plugin directory: %v", err)
	}

	buildActivationServiceHelper(t, filepath.Join(pluginDir, "backend", "service-helper"))

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: servicePermissionManifestWithCommand("demo", "backend/service-helper"),
		}
		st.PermissionGrants = map[string]map[string]bool{}

		if withToken {
			st.PermissionGrants["demo"] = map[string]bool{manifest.PersistentRCISessionWritePermission: true}
		}

		return nil
	}); err != nil {
		t.Fatalf("seed plugin state: %v", err)
	}

	persistentStore, err := rcisessionstore.Open(rcisessionstore.Config{
		CiphertextFile: cfg.RCISessionCiphertextFile(),
		KeyFile:        cfg.RCISessionKeyFile(),
	})
	if err != nil {
		t.Fatalf("open persistent RCI store: %v", err)
	}

	if withToken {
		if err := persistentStore.ReplaceController(model.TokenRecord{Token: "controller-token", Support: model.SupportSupported}); err != nil {
			t.Fatalf("seed controller token: %v", err)
		}
	}

	reg := registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir)
	activationGates := backend.NewActivationGateRegistry()
	runtime := backend.NewRuntime(backend.RuntimeConfig{
		RuntimeRoot:               cfg.PluginRuntimeRoot,
		ActivationGates:           activationGates,
		Limits:                    backend.Limits{MaxSupervisedServices: 1},
		SupportedServiceProtocols: []int{1},
		Supervisor: backend.SupervisorConfig{
			ReadinessTimeout: time.Second,
			StopTimeout:      time.Second,
			FinalReapTimeout: time.Second,
		},
	})

	accessMux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	core := daemonCore{
		cfg:             cfg,
		store:           store,
		reg:             reg,
		runtime:         runtime,
		activationGates: activationGates,
		logger:          logger,
		lifetime:        context.Background(),
	}
	registration := assembleRCISession(core, accessMux)

	if registration.coordinator == nil {
		t.Fatal("activation assembly was not wired")
	}

	gatewayMux := http.NewServeMux()
	gateway := registerPlugins(gatewayMux, core)

	fixture := &activationIntegrationFixture{
		store:    store,
		registry: reg,
		runtime:  runtime,
		assembly: registration.coordinator,
		gateway:  gateway,
		mux:      gatewayMux,
	}

	t.Cleanup(func() {
		_ = runtime.Shutdown(context.Background())

		registration.close()
	})

	return fixture
}

func readGatewayStatus(t *testing.T, fixture *activationIntegrationFixture) backendStatusResult {
	t.Helper()

	response := httptest.NewRecorder()

	fixture.mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/plugins/demo/_mndw/status", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status response = %d body=%s", response.Code, response.Body.String())
	}

	var result backendStatusResult

	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode status response: %v", err)
	}

	return result
}

type backendStatusResult struct {
	State    string           `json:"state"`
	Blockers []map[string]any `json:"blockers"`
}

func (f *activationIntegrationFixture) registryPlugins() []*registry.Plugin {
	return f.registry.AllBackendPlugins()
}

func waitForRuntimeState(t *testing.T, runtime *backend.RuntimeImpl, plugin string, want backend.ServiceState) {
	t.Helper()

	deadline := time.NewTimer(5 * time.Second)

	defer deadline.Stop()

	ticker := time.NewTicker(10 * time.Millisecond)

	defer ticker.Stop()

	for {
		status := runtime.Status(plugin)

		if status.State == want {
			return
		}

		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("runtime state = %#v, want %q", status, want)
		}
	}
}

func waitForReservedServices(t *testing.T, runtime *backend.RuntimeImpl, want int) {
	t.Helper()

	deadline := time.NewTimer(5 * time.Second)

	defer deadline.Stop()

	ticker := time.NewTicker(10 * time.Millisecond)

	defer ticker.Stop()

	for {
		got := runtime.Limits().ReservedServices

		if got == want {
			return
		}

		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("reserved services = %d, want %d", got, want)
		}
	}
}

type activationControllerTester struct {
	calls atomic.Int32
}

func (t *activationControllerTester) Test(context.Context, string) (rcisession.ControllerVerdict, error) {
	t.calls.Add(1)

	return rcisession.ControllerValid, nil
}

func saveController(t *testing.T, mux *http.ServeMux, token string) {
	t.Helper()

	body, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		t.Fatalf("marshal save body: %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/controller", bytes.NewReader(body))

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("save controller status = %d body=%s", response.Code, response.Body.String())
	}
}

func deleteController(t *testing.T, mux *http.ServeMux) {
	t.Helper()

	request := httptest.NewRequest(http.MethodDelete, "/api/mndw/rci-session/controller", nil)

	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("delete controller status = %d body=%s", response.Code, response.Body.String())
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()

	dir, err := os.MkdirTemp("/tmp", "mndw-")
	if err != nil {
		t.Fatalf("short temp dir: %v", err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	return dir
}

func unixSocketAvailable(t *testing.T) bool {
	t.Helper()

	listener, err := net.Listen("unix", filepath.Join(shortTempDir(t), "probe.sock"))
	if err == nil {
		_ = listener.Close()

		return true
	}

	if strings.Contains(err.Error(), "operation not permitted") {
		t.Skipf("Unix listener unavailable in test environment: %v", err)
	}

	t.Fatalf("probe Unix listener: %v", err)

	return false
}

func servicePermissionManifestWithCommand(name, command string) []byte {
	return []byte(`{"manifestVersion":1,"name":"` + name + `","version":"1.0.0","type":"page","label":"` + name + `","entry":"index.js","route":"/` + name + `","permissions":["persistent-rci-session:write"],"backend":{"kind":"service","protocolVersion":1,"command":"` + command + `","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`)
}

func buildActivationServiceHelper(t *testing.T, output string) {
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
