package telemetry

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestCache() *SnapshotCache {
	now := int64(1_700_000_000_000)
	cache := NewSnapshotCache(nil, nil)
	snapshot := emptySnapshot(true)
	snapshot.Keys["cpu"] = SeriesSnapshot{
		Label:     "CPU",
		Supported: true,
		Unit:      "percent",
		Tiers: map[string]TierSnapshot{
			"fine":   {StepMs: 180000, Samples: []Sample{{Timestamp: now, Mean: ptr(50), OK: true, Min: ptr(40), Max: ptr(60)}}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}
	cache.snapshot = snapshot

	return cache
}

func TestHandleGet_NoProject_ReturnsRawTiers(t *testing.T) {
	handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())

	req := httptest.NewRequest("GET", "/api/mndw/telemetry", nil)
	rec := httptest.NewRecorder()

	handler.handleGet(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body struct {
		Keys map[string]struct {
			Tiers map[string]json.RawMessage `json:"tiers"`
			Unit  string                     `json:"unit"`
		} `json:"keys"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	cpu, ok := body.Keys["cpu"]

	if !ok {
		t.Fatal("expected 'cpu' key in raw response")
	}

	if _, hasFine := cpu.Tiers["fine"]; !hasFine {
		t.Error("expected raw response to have 'tiers.fine'")
	}

	if cpu.Unit != "percent" {
		t.Errorf("expected unit 'percent', got %q", cpu.Unit)
	}
}

func TestHandleGet_Project7d_ReturnsProjectedWithMetadata(t *testing.T) {
	handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())

	req := httptest.NewRequest("GET", "/api/mndw/telemetry?project=7d", nil)
	rec := httptest.NewRecorder()

	handler.handleGet(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var projected ProjectedSnapshot

	if err := json.Unmarshal(rec.Body.Bytes(), &projected); err != nil {
		t.Fatal(err)
	}

	cpu, ok := projected.Keys["cpu"]

	if !ok {
		t.Fatal("expected 'cpu' key in projected response")
	}

	if len(cpu.Points) != 1 {
		t.Errorf("expected 1 projected point, got %d", len(cpu.Points))
	}

	if !cpu.Supported {
		t.Error("expected projected cpu.supported = true")
	}

	if cpu.Unit != "percent" {
		t.Errorf("expected projected cpu.unit = 'percent', got %q", cpu.Unit)
	}
}

func TestHandleGet_Project30d(t *testing.T) {
	handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())

	req := httptest.NewRequest("GET", "/api/mndw/telemetry?project=30d", nil)
	rec := httptest.NewRecorder()

	handler.handleGet(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestHandleGet_ProjectRanges(t *testing.T) {
	for _, project := range []string{"1h", "3h", "1d", "7d", "30d"} {
		t.Run(project, func(t *testing.T) {
			handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())
			req := httptest.NewRequest("GET", "/api/mndw/telemetry?project="+project, nil)
			rec := httptest.NewRecorder()

			handler.handleGet(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", rec.Code)
			}

			var projected ProjectedSnapshot

			if err := json.Unmarshal(rec.Body.Bytes(), &projected); err != nil {
				t.Fatal(err)
			}

			if _, ok := projected.Keys["cpu"]; !ok {
				t.Fatal("expected projected cpu key")
			}
		})
	}
}

func TestHandlerServesOnlySnapshotRoute(t *testing.T) {
	handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())
	mux := http.NewServeMux()

	handler.Register(mux)

	for _, tc := range []struct {
		path       string
		wantStatus int
	}{
		{path: "/api/mndw/" + "telemetry", wantStatus: http.StatusOK},
		{path: "/api/mndw/" + "telemetry" + "/annotations", wantStatus: http.StatusNotFound},
		{path: "/api/mndw/" + "telemetry" + "/sessions", wantStatus: http.StatusNotFound},
		{path: "/api/mndw/" + "telemetry" + "/sessions/s1-00000000000000000000000000000000", wantStatus: http.StatusNotFound},
	} {
		t.Run(tc.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()

			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, tc.path, nil))

			if recorder.Code != tc.wantStatus {
				t.Fatalf("GET %s status = %d, want %d", tc.path, recorder.Code, tc.wantStatus)
			}
		})
	}
}

func TestHandleGet_InvalidProject_ReturnsBadRequestWithoutTouchingCache(t *testing.T) {
	// Invalid project parameters return before reading or publishing the cache.
	cache := NewSnapshotCache(nil, nil)
	handler := NewHandler(cache, func() bool { return true }, slog.Default())

	for _, query := range []string{"?project=2h", "?project=", "?project=7d&project=30d", "?project=%zz"} {
		req := httptest.NewRequest("GET", "/api/mndw/telemetry"+query, nil)
		rec := httptest.NewRecorder()

		handler.handleGet(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("query %q: expected 400, got %d", query, rec.Code)
		}

		if query == "?project=2h" && !strings.Contains(rec.Body.String(), "project must be one of: 1h, 3h, 1d, 7d, 30d") {
			t.Errorf("query %q did not list valid project ranges: %s", query, rec.Body.String())
		}
	}

	if cache.snapshot != nil {
		t.Error("invalid project query unexpectedly touched the snapshot cache")
	}
}
