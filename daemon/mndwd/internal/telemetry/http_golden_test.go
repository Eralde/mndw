package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/events"
	"mndwd/internal/telemetry/annotations"
	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
	"mndwd/internal/telemetry/sessions"
)

var updateTelemetryGoldens = flag.Bool("update", false, "rewrite telemetry HTTP goldens from handler output")

const goldenNowMs = int64(1_800_000_000_000)

type goldenAnnotationCatalog struct{}

func (goldenAnnotationCatalog) Collections() []annotations.Collection {
	return []annotations.Collection{{Name: "load", Retention: 30 * 24 * time.Hour}, {Name: "temp", Retention: 30 * 24 * time.Hour}}
}

func (goldenAnnotationCatalog) LabelFor(topic string) (string, string, bool) {
	if topic == string(contractEvents.TopicWanConnected) {
		return "load", "WAN connected", true
	}

	return "", "", false
}

func TestTelemetryHTTPGoldenResponses(t *testing.T) {
	ctx := context.Background()
	now := time.UnixMilli(goldenNowMs).UTC()
	rrdDir := t.TempDir()

	history, err := NewHistory(journal.DefaultLimits(), DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	seedGoldenHistory(t, history, now)

	cache := NewSnapshotCache(history, func() time.Time { return now })

	cache.SetSupportedSeries(map[uint16]bool{1: true, 2: true})
	cache.SetSessionConfigured(func() bool { return true })

	if _, err := cache.Refresh(ctx, goldenSnapshotStatus()); err != nil {
		t.Fatalf("refresh snapshot cache: %v", err)
	}

	annotationStore, err := annotations.NewStore(annotations.Config{
		RRDDir:  rrdDir,
		Catalog: goldenAnnotationCatalog{},
		Now:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new annotation store: %v", err)
	}

	annotationStore.Consume(events.Event{
		ID:      "golden-annotation",
		Ts:      goldenNowMs,
		Topic:   contractEvents.TopicWanConnected,
		Source:  contractEvents.SourceHook,
		Payload: json.RawMessage(`{"interface":"ppp0","address":"192.0.2.1","mask":"255.255.255.0","gateway":"192.0.2.254"}`),
	})

	provider := seedGoldenSessionJournal(t, rrdDir)

	defer func() {
		if err := provider.Close(ctx); err != nil {
			t.Errorf("close session journal provider: %v", err)
		}
	}()

	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	handler := NewHandler(cache, func() bool { return true }, logger)

	handler.SetAnnotationStore(annotationStore)

	mux := http.NewServeMux()

	handler.Register(mux)
	sessions.RegisterRoutes(mux, sessions.NewReader(provider, func() sessions.Status {
		return sessionStatus(goldenPipelineStatus())
	}, journal.DefaultLimits()), logger)

	sessionID := sessions.SessionID(goldenBootID())
	cases := []struct {
		name string
		path string
	}{
		{name: "raw", path: "/api/mndw/telemetry"},
		{name: "projected", path: "/api/mndw/telemetry?project=7d"},
		{name: "annotations", path: "/api/mndw/telemetry/annotations"},
		{name: "sessions-list", path: "/api/mndw/telemetry/sessions"},
		{name: "sessions-detail", path: "/api/mndw/telemetry/sessions/" + sessionID},
	}
	bodies := make(map[string][]byte, len(cases))

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bodies[tc.name] = assertTelemetryHTTPGolden(t, mux, tc.name, tc.path, rrdDir)
		})
	}

	if len(bodies) != len(cases) {
		return
	}

	var raw Snapshot

	if err := json.Unmarshal(bodies["raw"], &raw); err != nil {
		t.Fatalf("decode raw snapshot: %v", err)
	}

	tempSamples := raw.Keys["temp"].Tiers["fine"].Samples

	if len(tempSamples) != 480 || tempSamples[len(tempSamples)-1].Mean == nil || *tempSamples[len(tempSamples)-1].Mean != 42 {
		t.Fatalf("temperature response has %d fine samples; last=%+v", len(tempSamples), tempSamples[len(tempSamples)-1])
	}

	var sessionList sessions.SessionList

	if err := json.Unmarshal(bodies["sessions-list"], &sessionList); err != nil {
		t.Fatalf("decode session list: %v", err)
	}

	status := sessionList.Storage

	if status.PendingSampleCount == nil || *status.PendingSampleCount != 2 || status.RebuildState != "rebuilding" {
		t.Fatalf("session pending/rebuild status = %+v", status)
	}

	if status.DeliveryError == nil || *status.DeliveryError != "fixture delivery unavailable" {
		t.Fatalf("session delivery error = %+v", status.DeliveryError)
	}

	if status.DroppedRecords["fixture"] != "3" {
		t.Fatalf("session dropped records = %#v", status.DroppedRecords)
	}

	if len(status.Coverage) != 1 || status.Coverage[0].Series != 1 || !status.Coverage[0].Complete ||
		status.Coverage[0].StartMs == nil || *status.Coverage[0].StartMs != 1_799_999_820_000 ||
		status.Coverage[0].EndMs == nil || *status.Coverage[0].EndMs != goldenNowMs {
		t.Fatalf("session coverage = %#v", status.Coverage)
	}

	if status.JournalBytes != nil {
		t.Fatalf("seeded journal size is expected to remain unreported, got %d", *status.JournalBytes)
	}
}

func assertTelemetryHTTPGolden(t *testing.T, mux *http.ServeMux, name, path, tempPath string) []byte {
	t.Helper()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, path, nil)

	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d, want %d: %s", path, recorder.Code, http.StatusOK, recorder.Body.String())
	}

	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("GET %s Cache-Control = %q, want no-store", path, got)
	}

	if strings.Contains(recorder.Body.String(), tempPath) {
		t.Fatalf("GET %s response leaked temporary directory %q", path, tempPath)
	}

	actual := recorder.Body.Bytes()
	fixturePath := filepath.Join("testdata", "http", name+".json")

	if *updateTelemetryGoldens {
		var indented bytes.Buffer

		if err := json.Indent(&indented, actual, "", "  "); err != nil {
			t.Fatalf("indent %s response: %v", name, err)
		}

		indented.WriteByte('\n')

		if err := os.MkdirAll(filepath.Dir(fixturePath), 0o755); err != nil {
			t.Fatalf("create fixture directory: %v", err)
		}

		if err := os.WriteFile(fixturePath, indented.Bytes(), 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", fixturePath, err)
		}

		t.Logf("updated telemetry HTTP fixture %s", fixturePath)

		return append([]byte(nil), actual...)
	}

	wantBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixture %s: %v (run Task 9 once with -update, then review the fixture)", fixturePath, err)
	}

	var want, got any

	if err := json.Unmarshal(wantBytes, &want); err != nil {
		t.Fatalf("decode fixture %s: %v", fixturePath, err)
	}

	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatalf("decode %s response: %v\n%s", name, err, actual)
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s response drifted from %s\n got: %s", name, fixturePath, actual)
	}

	return append([]byte(nil), actual...)
}

func seedGoldenHistory(t *testing.T, history *History, now time.Time) {
	t.Helper()

	coarseEnd := now.UTC().Truncate(time.Hour)
	fineEnd := now.UTC().Truncate(3 * time.Minute)
	updates := make([]SlotUpdate, 0, 42)
	sequence := uint64(0)

	for index := 0; index < 20; index++ {
		slot := coarseEnd.Add(-time.Hour).Add(time.Duration(index) * 3 * time.Minute)
		sequence++
		updates = append(updates,
			SlotUpdate{Series: 1, Row: Row{Slot: slot, Sequence: sequence, Values: []Value{{V: 20, Known: true}, {V: 40, Known: true}}}},
			SlotUpdate{Series: 2, Row: Row{Slot: slot, Sequence: sequence + 1, Values: []Value{{V: 42_000, Known: true}}}},
		)
		sequence++
	}

	latest := fineEnd.Add(-3 * time.Minute)

	if latest.After(coarseEnd.Add(-3 * time.Minute)) {
		sequence++
		updates = append(updates,
			SlotUpdate{Series: 1, Row: Row{Slot: latest, Sequence: sequence, Values: []Value{{V: 20, Known: true}, {V: 40, Known: true}}}},
			SlotUpdate{Series: 2, Row: Row{Slot: latest, Sequence: sequence + 1, Values: []Value{{V: 42_000, Known: true}}}},
		)
	}

	if err := history.store.Apply(Batch{Updates: updates}); err != nil {
		t.Fatal(err)
	}
}

func seedGoldenSessionJournal(t *testing.T, rrdDir string) journal.StorageProvider {
	t.Helper()

	paths, err := journal.PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatalf("journal paths: %v", err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatalf("new journal provider: %v", err)
	}

	opened, err := provider.Reopen(context.Background())
	if err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("open journal provider: %v", err)
	}

	if opened.Writer == nil {
		_ = provider.Close(context.Background())

		t.Fatal("opened journal has no writer")
	}

	boot := goldenBootID()
	bootStart, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180_000})
	if err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("prepare boot start: %v", err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{
		Boot:           boot,
		ClockSegment:   1,
		ElapsedMs:      180_000,
		UTCMs:          goldenNowMs,
		EvidenceID:     "golden-evidence",
		EvidenceSource: "fixture",
	})
	if err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("prepare anchor: %v", err)
	}

	sample, err := journal.PrepareSample(journal.Sample{
		Boot:         boot,
		ClockSegment: 1,
		Series:       1,
		ElapsedMs:    180_000,
		Values:       []journal.Value{{Known: true, V: 20}, {Known: true, V: 40}},
	})
	if err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("prepare sample: %v", err)
	}

	if _, err := opened.Writer.Append(context.Background(), []journal.Record{bootStart, anchor, sample}); err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("append journal fixture: %v", err)
	}

	if _, err := opened.Writer.Sync(context.Background()); err != nil {
		_ = provider.Close(context.Background())

		t.Fatalf("sync journal fixture: %v", err)
	}

	return provider
}

func goldenPipelineStatus() PipelineStatus {
	boot := goldenBootID()
	anchor := journal.Anchor{
		Boot:           boot,
		ClockSegment:   1,
		ElapsedMs:      180_000,
		UTCMs:          goldenNowMs,
		EvidenceID:     "golden-evidence",
		EvidenceSource: "fixture",
	}

	return PipelineStatus{
		Clock:          clock.View{State: clock.Anchored, Boot: boot, Segment: 1, Anchor: &anchor},
		PendingSamples: 2,
		RebuildState:   "rebuilding",
		Error:          "fixture delivery unavailable",
		Loss:           map[string]uint64{"fixture": 3},
		Coverage: []journal.Coverage{{
			Series:       1,
			StartMs:      goldenInt64(1_799_999_820_000),
			EndMs:        goldenInt64(goldenNowMs),
			EdgeComplete: true,
			Complete:     true,
		}},
	}
}

func goldenSnapshotStatus() PipelineStatus {
	status := goldenPipelineStatus()
	status.PendingSamples = 0

	return status
}

func goldenInt64(value int64) *int64 {
	return &value
}

func goldenBootID() journal.BootID {
	var boot journal.BootID
	boot[0] = 1

	return boot
}
