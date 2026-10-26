package system

import (
	"bytes"
	"context"
	"log/slog"
	"math"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestSyncEveryWindow(t *testing.T) {
	fsys := ringtest.NewMemFS()
	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}}
	clock := &fakeClock{bootID: testBootA, reading: testReading(0)}
	engine := NewEngine(testConfig(fsys, clock, source, &viewRecorder{}, nil))
	engine.cfg.SyncEvery = 3 * time.Minute

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	defer func() { _ = engine.Stop(context.Background()) }()

	firstWrite := int64(190_000)

	clock.set(testReading(firstWrite))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("first Handle(EventTick) error = %v", err)
	}

	pending := pendingPath(testBootA)
	initialSyncs := countOperation(fsys.Operations(), "sync", pending)

	if initialSyncs == 0 {
		t.Fatal("creating the pending ring did not sync its header")
	}

	if countOperation(fsys.Operations(), "sync", pending) != initialSyncs {
		t.Fatal("pending ring synced before SyncEvery elapsed")
	}

	clock.set(testReading(firstWrite + int64(3*time.Minute/time.Millisecond)))

	if err := engine.Handle(context.Background(), EventSync); err != nil {
		t.Fatalf("Handle(EventSync) error = %v", err)
	}

	if countOperation(fsys.Operations(), "sync", pending) != initialSyncs+1 {
		t.Fatalf("sync calls after first due window = %d, want %d", countOperation(fsys.Operations(), "sync", pending), initialSyncs+1)
	}

	if err := engine.Handle(context.Background(), EventSync); err != nil {
		t.Fatalf("repeated Handle(EventSync) error = %v", err)
	}

	if countOperation(fsys.Operations(), "sync", pending) != initialSyncs+1 {
		t.Fatal("repeated sync event without writes synced again")
	}

	clock.set(testReading(firstWrite + 2*int64(3*time.Minute/time.Millisecond)))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("second Handle(EventTick) error = %v", err)
	}

	clock.set(testReading(firstWrite + 3*int64(3*time.Minute/time.Millisecond)))

	if err := engine.Handle(context.Background(), EventSync); err != nil {
		t.Fatalf("second due Handle(EventSync) error = %v", err)
	}

	if countOperation(fsys.Operations(), "sync", pending) != initialSyncs+2 {
		t.Fatalf("sync calls after second dirty window = %d, want %d", countOperation(fsys.Operations(), "sync", pending), initialSyncs+2)
	}
}

func TestOverdueTickRunsFirst(t *testing.T) {
	engine, clock, _ := startEngine(t, ringtest.NewMemFS(), testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	clock.set(testReading(200_000))

	if err := engine.Handle(context.Background(), EventClockCheck); err != nil {
		t.Fatalf("Handle(EventClockCheck) error = %v", err)
	}

	kind, _ := engine.Next()

	if kind != EventTick {
		t.Fatalf("Next() kind = %v, want overdue EventTick", kind)
	}
}

func TestPendingOverflowKeepsNewestRows(t *testing.T) {
	fsys := ringtest.NewMemFS()
	var logBuffer bytes.Buffer
	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}, fallback: invalidNTPBody()}
	clock := &fakeClock{bootID: testBootA, reading: testReading(0)}
	collectCalls := 0
	cfg := testConfig(fsys, clock, source, &viewRecorder{}, func(context.Context) []float32 {
		collectCalls++

		return []float32{float32(collectCalls), float32(collectCalls + 1), float32(collectCalls + 2)}
	})
	cfg.Logger = slog.New(slog.NewTextHandler(&logBuffer, nil))
	engine := NewEngine(cfg)

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	defer func() { _ = engine.Stop(context.Background()) }()

	for index := 0; index < 14_400; index++ {
		bootMs := int64(index+1)*180_000 + 10_000

		clock.set(testReading(bootMs))

		if err := engine.Handle(context.Background(), EventTick); err != nil {
			t.Fatalf("Handle(EventTick) %d error = %v", index, err)
		}
	}

	source.mu.Lock()

	source.fallback = validNTPBody()

	source.mu.Unlock()

	lastBootMs := int64(14_401)*180_000 + 10_000

	clock.set(testReading(lastBootMs))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("overflow Handle(EventTick) error = %v", err)
	}

	if !engine.anchored() {
		t.Fatal("valid evidence after overflow did not anchor the engine")
	}

	if count := strings.Count(logBuffer.String(), "pending ring capacity exceeded"); count != 1 {
		t.Fatalf("overflow warning count = %d, want 1; logs: %s", count, logBuffer.String())
	}

	rows := 0
	minValue := float32(math.Inf(1))
	maxValue := float32(math.Inf(-1))

	engine.history.EachRow(func(_ int64, values []float32) {
		rows++

		if values[0] < minValue {
			minValue = values[0]
		}

		if values[0] > maxValue {
			maxValue = values[0]
		}
	})

	if rows != 14_400 {
		t.Fatalf("transferred rows = %d, want 14400", rows)
	}

	if minValue != 2 || maxValue != 14_401 {
		t.Fatalf("transferred first-value range = [%v, %v], want [2, 14401]", minValue, maxValue)
	}
}

func TestAnchoredHourlyPoll(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "saved.pool"})
	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

	source := &fakeNTP{errors: []error{syscall.EIO, syscall.EIO}}
	engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	previousDue := int64(-1)

	for iterations := 0; iterations < 2_000; iterations++ {
		kind, due := engine.Next()

		if due > int64(2*time.Hour/time.Millisecond) {
			break
		}

		if due < previousDue {
			t.Fatalf("Next() deadline moved backward: got %d before %d", due, previousDue)
		}

		previousDue = due

		clock.set(testReading(due))

		if err := engine.Handle(context.Background(), kind); err != nil {
			t.Fatalf("Handle(%v at %d) error = %v", kind, due, err)
		}
	}

	if source.calls() != 2 {
		t.Fatalf("anchored source calls in two hours = %d, want 2", source.calls())
	}
}

func TestClockChangeTriggersPoll(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})
	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

	source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
	engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	clock.set(testReading(10_000))

	if err := engine.Handle(context.Background(), EventClockCheck); err != nil {
		t.Fatalf("baseline Handle(EventClockCheck) error = %v", err)
	}

	changed := testReading(20_000)
	changed.WallMs += 5_000

	clock.set(changed)

	if err := engine.Handle(context.Background(), EventClockCheck); err != nil {
		t.Fatalf("changed Handle(EventClockCheck) error = %v", err)
	}

	if source.calls() != 1 {
		t.Fatalf("source calls after clock change = %d, want 1", source.calls())
	}
}

func TestNTPSourceErrorBackoff(t *testing.T) {
	t.Run("anchored hourly", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

		seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "saved.pool"})
		seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

		source := &fakeNTP{errors: []error{syscall.EIO, syscall.EIO}}
		engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, nil)

		defer func() { _ = engine.Stop(context.Background()) }()

		for _, bootMs := range []int64{3_600_000, 7_200_000} {
			clock.set(testReading(bootMs))

			if err := engine.Handle(context.Background(), EventClockCheck); err != nil {
				t.Fatalf("Handle(EventClockCheck) error = %v", err)
			}
		}

		if source.calls() != 2 {
			t.Fatalf("anchored source calls = %d, want 2", source.calls())
		}
	})

	t.Run("unanchored once per tick", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		source := &fakeNTP{errors: []error{syscall.EIO}}
		engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, nil)

		defer func() { _ = engine.Stop(context.Background()) }()

		for _, bootMs := range []int64{190_000, 370_000} {
			clock.set(testReading(bootMs))

			if err := engine.Handle(context.Background(), EventTick); err != nil {
				t.Fatalf("Handle(EventTick) error = %v", err)
			}
		}

		if source.calls() != 3 {
			t.Fatalf("unanchored source calls including Start = %d, want 3", source.calls())
		}
	})

	t.Run("clock change retries every check until decode", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

		seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})
		seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

		var logBuffer bytes.Buffer
		source := &fakeNTP{errors: []error{syscall.EIO, syscall.EIO, nil}, bodies: [][]byte{nil, nil, validNTPBody()}}
		clock := &fakeClock{bootID: testBootA, reading: testReading(0)}
		cfg := testConfig(fsys, clock, source, &viewRecorder{}, nil)
		cfg.Logger = slog.New(slog.NewTextHandler(&logBuffer, nil))
		engine := NewEngine(cfg)

		if err := engine.Start(context.Background()); err != nil {
			t.Fatalf("Start() error = %v", err)
		}

		defer func() { _ = engine.Stop(context.Background()) }()

		for _, reading := range []timekeeper.Reading{testReading(10_000), {BootMs: 20_000, WallMs: testReading(20_000).WallMs + 5_000}, {BootMs: 30_000, WallMs: testReading(30_000).WallMs + 5_000}, {BootMs: 40_000, WallMs: testReading(40_000).WallMs + 5_000}} {
			clock.set(reading)

			if err := engine.Handle(context.Background(), EventClockCheck); err != nil {
				t.Fatalf("Handle(EventClockCheck) error = %v", err)
			}
		}

		if source.calls() != 3 {
			t.Fatalf("source calls through successful decode = %d, want 3", source.calls())
		}

		if count := strings.Count(logBuffer.String(), "NTP poll failed"); count != 1 {
			t.Fatalf("logged error streaks = %d, want 1; logs: %s", count, logBuffer.String())
		}
	})
}

func countOperation(ops [][2]string, name, path string) int {
	count := 0

	for _, op := range ops {
		if op[0] == name && op[1] == path {
			count++
		}
	}

	return count
}

func TestNTPDecisionsAreLoggedOncePerReason(t *testing.T) {
	fsys := ringtest.NewMemFS()
	var logBuffer bytes.Buffer
	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}, fallback: invalidNTPBody()}
	clock := &fakeClock{bootID: testBootA, reading: testReading(0)}
	cfg := testConfig(fsys, clock, source, &viewRecorder{}, nil)
	cfg.Logger = slog.New(slog.NewTextHandler(&logBuffer, nil))
	engine := NewEngine(cfg)

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	defer func() { _ = engine.Stop(context.Background()) }()

	for index := 0; index < 3; index++ {
		clock.set(testReading(int64(index+1)*180_000 + 10_000))

		if err := engine.Handle(context.Background(), EventTick); err != nil {
			t.Fatalf("Handle(EventTick) %d error = %v", index, err)
		}
	}

	if count := strings.Count(logBuffer.String(), `msg="NTP evidence not accepted"`); count != 1 {
		t.Fatalf("rejection log count = %d, want 1; logs: %s", count, logBuffer.String())
	}

	if !strings.Contains(logBuffer.String(), `reason="not NTP evidence"`) {
		t.Fatalf("rejection log has no reason; logs: %s", logBuffer.String())
	}

	source.mu.Lock()

	source.fallback = validNTPBody()

	source.mu.Unlock()

	clock.set(testReading(4*180_000 + 10_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	if !engine.anchored() {
		t.Fatal("valid evidence did not anchor the engine")
	}

	if count := strings.Count(logBuffer.String(), `msg="NTP evidence accepted"`); count != 1 {
		t.Fatalf("acceptance log count = %d, want 1; logs: %s", count, logBuffer.String())
	}
}
