package telemetry

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/events"
	"mndwd/internal/telemetry/annotations"
)

type apiAnnotationCatalog struct{}

func (apiAnnotationCatalog) Collections() []annotations.Collection {
	return []annotations.Collection{{Name: "load", Retention: time.Hour}, {Name: "temp", Retention: 2 * time.Hour}}
}

func (apiAnnotationCatalog) LabelFor(topic string) (string, string, bool) {
	if topic == string(contractEvents.TopicWanConnected) {
		return "load", "WAN connected", true
	}

	return "", "", false
}

func apiAnnotationEvent(id string, ts int64) events.Event {
	return events.Event{
		ID:      id,
		Ts:      ts,
		Topic:   contractEvents.TopicWanConnected,
		Source:  contractEvents.SourceHook,
		Payload: json.RawMessage(`{"interface":"ppp0","address":"192.0.2.1","mask":"255.255.255.0","gateway":"192.0.2.254"}`),
	}
}

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

func TestHandleAnnotationsReturnsCollections(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	store, err := annotations.NewStore(annotations.Config{
		RRDDir:  t.TempDir(),
		Catalog: apiAnnotationCatalog{},
		Now:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	store.Consume(apiAnnotationEvent("annotation", now.UnixMilli()))

	handler := NewHandler(newTestCache(), func() bool { return true }, slog.Default())

	handler.SetAnnotationStore(store)

	req := httptest.NewRequest("GET", "/api/mndw/telemetry/annotations", nil)
	rec := httptest.NewRecorder()

	handler.handleAnnotations(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	var body struct {
		Collections map[string][]annotations.Annotation `json:"collections"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if len(body.Collections["load"]) != 1 {
		t.Fatalf("collections = %#v", body.Collections)
	}
}
