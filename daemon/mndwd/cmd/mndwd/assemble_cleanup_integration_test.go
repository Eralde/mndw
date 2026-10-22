package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mndwd/internal/authz"
	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/palette"
	"mndwd/internal/rcisession/model"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type cleanupFixture struct {
	cfg          Config
	store        *state.Store
	paletteStore *palette.Store
	verifier     *authz.Verifier
	logger       *slog.Logger
	socketPath   string
}

// newCleanupFixture seeds a granted persistent-RCI service plugin and a
// controller token, so building components binds the plugin's RCI socket. The
// token makes the session loop enumerate members, so ControllerURL points at a
// local fake controller that reports no members; the test never reaches a real
// controller or starts establishment work. deviceURL is independent of it.
func newCleanupFixture(t *testing.T, deviceURL string) cleanupFixture {
	t.Helper()

	controller := newFrontDoorIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/rci/" {
			http.NotFound(writer, request)

			return
		}

		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(writer, "read body", http.StatusBadRequest)

			return
		}

		writer.Header().Set("Content-Type", "application/json")

		if strings.Contains(string(body), "authentication token generate") {
			_, _ = io.WriteString(writer, `{"probe":{"found":true}}`)

			return
		}

		_, _ = io.WriteString(writer, `[{"show":{"mws":{"member":[]}}}]`)
	}))

	t.Cleanup(controller.Close)

	cfg := frontDoorTestConfig(t, "", deviceURL)
	cfg.ControllerURL = controller.URL
	cfg.PluginRuntimeRoot = filepath.Join(shortTempDir(t), "runtime")

	if err := os.MkdirAll(cfg.UserPluginsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: servicePermissionManifestWithCommand("demo", "backend/server"),
		}
		st.PermissionGrants = map[string]map[string]bool{
			"demo": {manifest.PersistentRCISessionWritePermission: true},
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

	if err := persistentStore.ReplaceController(model.TokenRecord{Token: "controller-token", Support: model.SupportSupported}); err != nil {
		t.Fatalf("seed controller token: %v", err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		t.Fatalf("palette.Open: %v", err)
	}

	paths, err := backend.NewRuntimePaths(cfg.PluginRuntimeRoot, "demo")
	if err != nil {
		t.Fatalf("runtime paths: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	return cleanupFixture{
		cfg:          cfg,
		store:        store,
		paletteStore: paletteStore,
		verifier:     authz.New(cfg.DeviceURL, cfg.Dev, logger, authz.Options{}),
		logger:       logger,
		socketPath:   paths.RCISessionSocket,
	}
}

func TestAssembleTokenlessSurvivesStoreOpenFailure(t *testing.T) {
	controller := newFrontDoorIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")

		_, _ = io.WriteString(writer, `{"probe":{"found":false}}`)
	}))

	t.Cleanup(controller.Close)

	cfg := frontDoorTestConfig(t, "", "http://127.0.0.1:80")
	cfg.ControllerURL = controller.URL
	cfg.RCIProxyOperationTimeout = time.Second
	cfg.RCIProxyMaxResponseBytes = 1 << 20
	blockedParent := filepath.Join(t.TempDir(), "not-a-directory")

	if err := os.WriteFile(blockedParent, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg.RCISessionKeyDir = filepath.Join(blockedParent, "keys")

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	core := daemonCore{
		cfg:             cfg,
		store:           store,
		reg:             registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir),
		activationGates: backend.NewActivationGateRegistry(),
		logger:          logger,
		lifetime:        context.Background(),
	}
	mux := http.NewServeMux()
	registration := assembleRCISession(core, mux, nil)

	if registration.close != nil {
		t.Cleanup(registration.close)
	}

	if registration.err != nil {
		t.Fatalf("assembleRCISession returned error: %v", registration.err)
	}

	if registration.permissionController == nil {
		t.Fatal("assembleRCISession did not create permission controller after token store open failure")
	}

	request := httptest.NewRequest(http.MethodGet, "/api/mndw/rci-session/capability", nil)

	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("capability status = %d body=%s", response.Code, response.Body.String())
	}

	var report struct {
		Store struct {
			State string `json:"state"`
		} `json:"store"`
		Controller struct {
			Auth string `json:"auth"`
		} `json:"controller"`
	}

	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode capability: %v", err)
	}

	if report.Store.State != "disabled" || report.Controller.Auth != "none" {
		t.Fatalf("capability store=%q auth=%q, want disabled and none", report.Store.State, report.Controller.Auth)
	}
}

func socketExists(path string) bool {
	info, err := os.Stat(path)

	return err == nil && info.Mode()&os.ModeSocket != 0
}

func TestBuildComponentsRegistersClosersInConstructionOrder(t *testing.T) {
	device := newFrontDoorIPv4Server(http.NotFoundHandler())

	t.Cleanup(device.Close)

	fixture := newCleanupFixture(t, device.URL)

	c, err := buildComponents(fixture.cfg, fixture.store, fixture.paletteStore, fixture.verifier, fixture.logger, context.Background())

	t.Cleanup(func() { _ = c.Close() })

	if err != nil {
		t.Fatalf("buildComponents: %v", err)
	}

	names := make([]string, 0, len(c.cleanup.closers))

	for _, closer := range c.cleanup.closers {
		names = append(names, closer.name)
	}

	if want := []string{"backend runtime", "persistent RCI session", "telemetry", "events"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("closer registration order = %v, want %v", names, want)
	}
}

func TestAssembleStartupFailureUnwindsSession(t *testing.T) {
	if !unixSocketAvailable(t) {
		return
	}

	control := newCleanupFixture(t, "http://")
	built, buildErr := buildComponents(control.cfg, control.store, control.paletteStore, control.verifier, control.logger, context.Background())

	if buildErr == nil {
		_ = built.Close()

		t.Fatal("buildComponents accepted a device URL without a host")
	}

	if !socketExists(control.socketPath) {
		_ = built.Close()

		t.Fatalf("session did not bind %s during build; the failure-path check below would prove nothing", control.socketPath)
	}

	_ = built.Close()

	fixture := newCleanupFixture(t, "http://")
	c, err := assemble(fixture.cfg, fixture.store, fixture.paletteStore, fixture.verifier, fixture.logger, context.Background())

	if err == nil {
		_ = c.Close()

		t.Fatal("assemble accepted a device URL without a host")
	}

	if !strings.Contains(err.Error(), "device URL must include scheme and host") {
		t.Fatalf("assemble error = %v, want device URL error", err)
	}

	if c != nil {
		t.Fatal("assemble returned components together with an error")
	}

	if socketExists(fixture.socketPath) {
		t.Fatalf("persistent RCI socket %s still exists after failed assemble; the session closer did not run", fixture.socketPath)
	}
}

func TestAssembleReportsEveryStartupError(t *testing.T) {
	if !unixSocketAvailable(t) {
		return
	}

	fixture := newCleanupFixture(t, "http://")
	fixture.cfg.FrontendDir = t.TempDir()

	c, err := assemble(fixture.cfg, fixture.store, fixture.paletteStore, fixture.verifier, fixture.logger, context.Background())
	if err == nil {
		if c != nil {
			_ = c.Close()
		}

		t.Fatal("assemble accepted startup errors")
	}

	if !strings.Contains(err.Error(), "device URL must include scheme and host") || !strings.Contains(err.Error(), "device proxy:") {
		t.Fatalf("assemble error = %v, want device info and front-door proxy errors", err)
	}

	if c != nil {
		t.Fatal("assemble returned components together with an error")
	}
}
