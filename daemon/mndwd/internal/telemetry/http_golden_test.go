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
	"testing"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

var updateTelemetryGoldens = flag.Bool("update", false, "rewrite telemetry HTTP goldens from handler output")

const goldenNowMs = int64(1_800_000_000_000)

func TestTelemetryHTTPGoldenResponses(t *testing.T) {
	ctx := context.Background()
	now := time.UnixMilli(goldenNowMs).UTC()
	fsys := ringtest.NewMemFS()
	bootID := [16]byte{1}

	seedGoldenRing(t, fsys, now)
	seedGoldenState(t, fsys, timekeeper.State{
		BootID:   bootID,
		OffsetMs: goldenNowMs,
		Server:   "pool.ntp.org",
	})

	clock := &capabilityClock{
		bootID: bootID,
		reading: timekeeper.Reading{
			BootMs: 10_000,
			WallMs: goldenNowMs + 10_000,
		},
	}
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:             "golden",
		FS:                 fsys,
		Clock:              clock,
		LoadSampler:        collectorTestSampler{supported: true},
		TemperatureSampler: collectorTestSampler{supported: true},
		DesiredEnabled:     func() bool { return true },
		SessionConfigured:  func() bool { return true },
		CheckFS:            func(string) error { return nil },
		Lock:               func(string) (func() error, error) { return func() error { return nil }, nil },
		WaitUntil: func(ctx context.Context, _ int64) error {
			<-ctx.Done()

			return ctx.Err()
		},
	})

	if err := capability.Start(ctx); err != nil {
		t.Fatalf("start ring capability: %v", err)
	}

	t.Cleanup(func() {
		if err := capability.Close(context.Background()); err != nil {
			t.Errorf("close ring capability: %v", err)
		}
	})

	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	handler := NewHandler(capability.SnapshotCache(), capability.IsEnabled, logger)

	mux := http.NewServeMux()

	handler.Register(mux)

	cases := []struct {
		name string
		path string
	}{
		{name: "raw", path: "/api/mndw/telemetry"},
		{name: "projected", path: "/api/mndw/telemetry?project=7d"},
	}
	bodies := make(map[string][]byte, len(cases))

	entries, err := os.ReadDir(filepath.Join("testdata", "http"))
	if err != nil {
		t.Fatalf("read telemetry HTTP fixture directory: %v", err)
	}

	gotFixtures := make([]string, len(entries))

	for index, entry := range entries {
		gotFixtures[index] = entry.Name()
	}

	if wantFixtures := []string{"projected.json", "raw.json"}; !reflect.DeepEqual(gotFixtures, wantFixtures) {
		t.Fatalf("telemetry HTTP fixtures = %v, want exactly %v", gotFixtures, wantFixtures)
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bodies[tc.name] = assertTelemetryHTTPGolden(t, mux, tc.name, tc.path)
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

}

func assertTelemetryHTTPGolden(t *testing.T, mux *http.ServeMux, name, path string) []byte {
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

func seedGoldenRing(t *testing.T, fsys ring.FS, now time.Time) {
	t.Helper()

	coarseEnd := now.UTC().Truncate(time.Hour)
	fineEnd := now.UTC().Truncate(3 * time.Minute)
	rows := make(map[int64][]float32, 21)

	for index := 0; index < 20; index++ {
		slot := coarseEnd.Add(-time.Hour).Add(time.Duration(index) * 3 * time.Minute)
		rows[slot.UnixMilli()/int64(ring.SystemSchema(ring.KindHistory).StepMs)] = []float32{20, 40, 42_000}
	}

	latest := fineEnd.Add(-3 * time.Minute)

	if latest.After(coarseEnd.Add(-3 * time.Minute)) {
		rows[latest.UnixMilli()/int64(ring.SystemSchema(ring.KindHistory).StepMs)] = []float32{20, 40, 42_000}
	}

	seedRingForCapability(t, fsys, filepath.Join("golden", "ring", "system.ring"), ring.SystemSchema(ring.KindHistory), rows)
}

func seedGoldenState(t *testing.T, fsys *ringtest.MemFS, state timekeeper.State) {
	t.Helper()

	body, err := timekeeper.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}

	path := filepath.Join("golden", "ring", "clock.state")

	if err := fsys.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	file, err := fsys.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	if n, err := file.WriteAt(body, 0); err != nil || n != len(body) {
		t.Fatalf("WriteAt(clock.state) = (%d, %v), want (%d, nil)", n, err, len(body))
	}

	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if err := fsys.SyncDir(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
}
