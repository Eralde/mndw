package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"mndwd/internal/authz"
	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/palette"
	"mndwd/internal/rcisession/model"
	rcisessionstore "mndwd/internal/rcisession/store"
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

		writer.Header().Set("Content-Type", "application/json")

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
