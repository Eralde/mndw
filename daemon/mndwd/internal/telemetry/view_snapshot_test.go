package telemetry

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/system"
	"mndwd/internal/telemetry/timekeeper"
)

func TestSnapshotScenariosRingImplementation(t *testing.T) {
	runSnapshotScenarios(t, ringSnapshotBuilder, true)
}

func TestViewSnapshotCurrentRequiresNoPending(t *testing.T) {
	view := system.View{
		NowMs:         scenarioNowMs,
		Anchored:      true,
		ReplayPending: true,
		Window: func(_ int64, count int) [][]float32 {
			rows := make([][]float32, count)

			for index := range rows {
				rows[index] = []float32{20, 40, 42_000}
			}

			return rows
		},
	}

	snapshot := buildViewSnapshot(view, map[uint16]bool{2: true})

	if snapshot.Clock.HistoryCurrent {
		t.Fatal("historyCurrent = true with replay pending, want false")
	}

	if !snapshot.Clock.ReplayPending {
		t.Fatal("replayPending = false, want true")
	}
}

func TestRingSnapshotNowFollowsOffsetAfterClockChange(t *testing.T) {
	scenario := ringNowFromOffsetScenario(time.UnixMilli(scenarioNowMs).UTC())
	fsys := ringtest.NewMemFS()
	const dir = "snapshot/ring"

	if err := fsys.MkdirAll(filepath.Join(dir, "pending"), 0o755); err != nil {
		t.Fatal(err)
	}

	seedSnapshotRows(t, fsys, filepath.Join(dir, "system.ring"), scenario.Rows)

	const bootNow = int64(900_000)
	offset := scenario.NowMs - bootNow
	bootID := [16]byte{0x71, 0x6a, 0x51, 0x2b, 0x9d, 0x84, 0x4c, 0xe0, 0xb3, 0x27, 0x80, 0x6f, 0x23, 0x11, 0x49, 0xa5}
	clock := &snapshotClock{
		bootID: bootID,
		reading: timekeeper.Reading{
			BootMs: bootNow,
			WallMs: bootNow + offset,
		},
	}

	seedSnapshotClockState(t, fsys, dir, timekeeper.State{BootID: bootID, OffsetMs: offset, Server: "pool.ntp.org"})

	cache := NewSnapshotCache(nil, func() bool { return true })

	cache.SetSupportedSeries(map[uint16]bool{2: true})

	var published system.View
	engine := system.NewEngine(system.Config{
		Dir:   dir,
		FS:    fsys,
		Clock: clock,
		NTP: func(context.Context) ([]byte, error) {
			return []byte(`{"elapsed":0,"server":"","accurate":false,"synchronized":false,"ndsstime":false,"usertime":false}`), nil
		},
		Publish: func(view system.View) {
			published = view

			cache.PublishView(view)
		},
		Keeper: timekeeper.DefaultConfig(),
		Delay:  10 * time.Second,
	})

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	if err := engine.Handle(context.Background(), system.EventClockCheck); err != nil {
		t.Fatalf("initial Handle(EventClockCheck) error = %v", err)
	}

	before, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if before.Clock == nil || before.Clock.HistoryEndMs == nil {
		t.Fatalf("initial snapshot has no known history end: %+v", before.Clock)
	}

	beforeEnd := *before.Clock.HistoryEndMs

	clock.reading.WallMs += 2 * time.Hour.Milliseconds()

	if err := engine.Handle(context.Background(), system.EventClockCheck); err != nil {
		t.Fatalf("Handle(EventClockCheck) error = %v", err)
	}

	after, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if published.NowMs != bootNow+offset {
		t.Fatalf("published NowMs = %d, want boot clock plus stored offset %d", published.NowMs, bootNow+offset)
	}

	if after.Clock == nil || after.Clock.HistoryEndMs == nil || *after.Clock.HistoryEndMs != beforeEnd {
		t.Fatalf("fine window end changed after wall-clock jump: before=%d after=%+v", beforeEnd, after.Clock)
	}

	if beforeEnd != *after.Clock.HistoryEndMs {
		t.Fatalf("fineEnd changed from %d to %d", beforeEnd, *after.Clock.HistoryEndMs)
	}

	if *updateTelemetryGoldens {
		return
	}

	want := readSnapshotScenarioRaw(t, scenario.Name)

	if !reflect.DeepEqual(after, want) {
		gotJSON, _ := json.Marshal(after)
		wantJSON, _ := json.Marshal(want)

		t.Fatalf("offset snapshot differs from ring-only fixture\n got: %s\nwant: %s", gotJSON, wantJSON)
	}
}

func TestViewSnapshotFloat32Values(t *testing.T) {
	view := system.View{
		NowMs: scenarioNowMs + 10_000,
		Window: func(_ int64, count int) [][]float32 {
			rows := make([][]float32, count)

			for index := range rows {
				rows[index] = []float32{20, float32(37.8), 42_000}
			}

			return rows
		},
	}
	snapshot := buildViewSnapshot(view, map[uint16]bool{2: true})
	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	var decoded struct {
		Keys map[string]struct {
			Tiers map[string]struct {
				Samples []struct {
					Mean *float64 `json:"mean"`
				} `json:"samples"`
			} `json:"tiers"`
		} `json:"keys"`
	}

	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}

	samples := decoded.Keys["ram"].Tiers["fine"].Samples

	if len(samples) == 0 || samples[len(samples)-1].Mean == nil || *samples[len(samples)-1].Mean != 37.8 {
		t.Fatalf("JSON ram value = %+v, want 37.8", samples)
	}
}

func ringSnapshotBuilder(t *testing.T, sc snapshotScenario) *Snapshot {
	t.Helper()

	fsys := ringtest.NewMemFS()
	const path = "snapshot.ring"
	stored, err := ring.Open(fsys, path, ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		t.Fatal(err)
	}

	for _, row := range sc.Rows {
		values := []float32{scenarioFloat32(row.CPU), scenarioFloat32(row.RAM), scenarioFloat32(row.TempMilli)}

		if err := stored.Write(row.SlotStartMs/ringStepMs, values); err != nil {
			t.Fatalf("Write(slot %d) error = %v", row.SlotStartMs/ringStepMs, err)
		}
	}

	if err := stored.Close(); err != nil {
		t.Fatal(err)
	}

	nowMs := sc.NowMs

	if !sc.RingOnly {
		nowMs += 10_000
	}

	view := system.View{
		NowMs:         nowMs,
		Anchored:      sc.Anchored,
		ReplayPending: sc.ReplayPending,
		Window:        stored.Window,
	}
	cache := NewSnapshotCache(nil, func() bool { return true })

	cache.SetSupportedSeries(map[uint16]bool{2: sc.TempSupported})
	cache.PublishView(view)

	snapshot, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	return snapshot
}

const ringStepMs = int64(180_000)

func scenarioFloat32(value float64) float32 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return float32(math.NaN())
	}

	return float32(value)
}

func seedSnapshotRows(t *testing.T, fsys *ringtest.MemFS, path string, rows []scenarioRow) {
	t.Helper()

	stored, err := ring.Open(fsys, path, ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		t.Fatal(err)
	}

	for _, row := range rows {
		if err := stored.Write(row.SlotStartMs/ringStepMs, []float32{
			scenarioFloat32(row.CPU), scenarioFloat32(row.RAM), scenarioFloat32(row.TempMilli),
		}); err != nil {
			t.Fatal(err)
		}
	}

	if err := stored.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := stored.Close(); err != nil {
		t.Fatal(err)
	}
}

func seedSnapshotClockState(t *testing.T, fsys *ringtest.MemFS, dir string, state timekeeper.State) {
	t.Helper()

	if err := fsys.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	body, err := timekeeper.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}

	file, err := fsys.OpenFile(filepath.Join(dir, "clock.state"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Truncate(0); err != nil {
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

	if err := fsys.SyncDir(dir); err != nil {
		t.Fatal(err)
	}
}

func readSnapshotScenarioRaw(t *testing.T, name string) *Snapshot {
	t.Helper()

	return readSnapshotScenarioGolden(t, name).Raw
}

type snapshotClock struct {
	bootID  [16]byte
	reading timekeeper.Reading
}

func (c *snapshotClock) Read() (timekeeper.Reading, error) {
	return c.reading, nil
}

func (c *snapshotClock) BootID() [16]byte {
	return c.bootID
}
