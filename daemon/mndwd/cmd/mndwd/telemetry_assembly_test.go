package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mndwd/internal/rcisession"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/system"
	"mndwd/internal/telemetry/timekeeper"
)

func TestAssembleTelemetryWithoutCapabilityReturnsNilController(t *testing.T) {
	service, err := rcisession.NewService(rcisession.ServiceConfig{Store: rcisessionstore.Disabled()})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	stateStore, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	rrdDir := t.TempDir()
	core := daemonCore{
		cfg:    Config{RRDDir: rrdDir},
		store:  stateStore,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	session := rciSessionAssembly{service: service, lifetime: context.Background()}
	result := assembleTelemetryWith(core, mux, session, func(telemetry.CapabilityConfig) (*telemetry.Capability, error) {
		return nil, errors.New("capability unavailable")
	})

	if result.controller != nil {
		t.Fatalf("controller = %#v, want nil interface", result.controller)
	}

	if result.capability != nil || result.err != nil {
		t.Fatalf("result = %+v, want capability and err unset", result)
	}

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry", nil))

	if response.Code != http.StatusNotFound {
		t.Fatalf("telemetry status = %d, want 404", response.Code)
	}

	entries, err := os.ReadDir(rrdDir)
	if err != nil {
		t.Fatalf("ReadDir RRD dir: %v", err)
	}

	if len(entries) != 0 {
		t.Fatalf("RRD dir entries = %v, want empty", entries)
	}
}

func TestAssembleTelemetryUsesCapability(t *testing.T) {
	service, err := rcisession.NewService(rcisession.ServiceConfig{Store: rcisessionstore.Disabled()})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	stateStore, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	core := daemonCore{
		cfg:    Config{RRDDir: t.TempDir(), TelemetryMaxUnsynced: 7 * time.Minute},
		store:  stateStore,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	session := rciSessionAssembly{service: service, lifetime: context.Background()}
	var factoryCalled bool
	result := assembleTelemetryWith(core, mux, session, func(config telemetry.CapabilityConfig) (*telemetry.Capability, error) {
		factoryCalled = true

		if config.RRDDir != core.cfg.RRDDir {
			t.Errorf("RRDDir = %q, want %q", config.RRDDir, core.cfg.RRDDir)
		}

		if config.MaxUnsynced != core.cfg.TelemetryMaxUnsynced {
			t.Errorf("MaxUnsynced = %s, want %s", config.MaxUnsynced, core.cfg.TelemetryMaxUnsynced)
		}

		if config.NTP == nil {
			t.Error("NTP source is nil")
		}

		config.Clock = assemblyTestClock{}
		config.FS = ringtest.NewMemFS()
		config.DesiredEnabled = func() bool { return true }
		config.CheckFS = func(string) error { return nil }
		config.Lock = func(string) (func() error, error) { return func() error { return nil }, nil }

		return telemetry.NewCapability(config)
	})

	if !factoryCalled {
		t.Fatal("ring capability factory was not called")
	}

	if result.err != nil {
		t.Fatalf("assembleTelemetryWith() error = %v", result.err)
	}

	if result.capability == nil {
		t.Fatal("assembled capability is nil")
	}

	if result.controller != result.capability {
		t.Fatalf("controller = %#v, want assembled ring capability", result.controller)
	}

	if _, ok := result.controller.(*telemetry.Capability); !ok {
		t.Fatalf("controller type = %T, want *telemetry.Capability", result.controller)
	}

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/mndw/telemetry status = %d, want 200: %s", response.Code, response.Body.String())
	}
}

type assemblyTestClock struct{}

func (assemblyTestClock) Read() (timekeeper.Reading, error) {
	return timekeeper.Reading{}, nil
}

func (assemblyTestClock) BootID() [16]byte { return [16]byte{1} }

var _ system.Clock = assemblyTestClock{}

func TestAssembleTelemetryWithoutSessionIsEmpty(t *testing.T) {
	mux := http.NewServeMux()
	result := assembleTelemetry(daemonCore{}, mux, rciSessionAssembly{})

	if result != (telemetryAssembly{}) {
		t.Fatalf("assembleTelemetry result = %+v, want zero value", result)
	}

	for _, path := range []string{"/api/mndw/" + "telemetry", "/api/mndw/" + "telemetry" + "/annotations", "/api/mndw/" + "telemetry" + "/sessions"} {
		response := httptest.NewRecorder()

		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))

		if response.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", path, response.Code)
		}
	}
}
