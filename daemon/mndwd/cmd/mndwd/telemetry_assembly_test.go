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

	"mndwd/internal/rcisession"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
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

	if result.capability != nil || result.annotations != nil || result.err != nil {
		t.Fatalf("result = %+v, want capability, annotations, and err unset", result)
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
		t.Fatalf("RRD dir entries = %v, want empty because annotation store was not opened", entries)
	}
}

func TestAssembleTelemetryWithoutSessionIsEmpty(t *testing.T) {
	mux := http.NewServeMux()
	result := assembleTelemetry(daemonCore{}, mux, rciSessionAssembly{})

	if result != (telemetryAssembly{}) {
		t.Fatalf("assembleTelemetry result = %+v, want zero value", result)
	}

	for _, path := range []string{"/api/mndw/telemetry", "/api/mndw/telemetry/sessions"} {
		response := httptest.NewRecorder()

		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))

		if response.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", path, response.Code)
		}
	}
}
