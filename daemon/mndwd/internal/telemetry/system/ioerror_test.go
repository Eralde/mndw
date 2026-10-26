package system

import (
	"context"
	"math"
	"path/filepath"
	"syscall"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestWriteErrorDropsTicksAndDegradesStatus(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "saved.pool"})
	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}}
	views := &viewRecorder{}
	clock := &fakeClock{bootID: testBootA, reading: testReading(0)}
	collectCalls := 0
	cfg := testConfig(fsys, clock, source, views, func(context.Context) []float32 {
		collectCalls++

		return []float32{1, 2, 3}
	})
	engine := NewEngine(cfg)

	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	defer func() { _ = engine.Stop(context.Background()) }()

	fsys.FailNext("writeat", filepath.Join(testDir, "system.ring"), syscall.EIO)
	clock.set(testReading(190_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("first Handle(EventTick) error = %v", err)
	}

	if !engine.storageDown {
		t.Fatal("ring write EIO did not mark storage down")
	}

	if collectCalls != 1 {
		t.Fatalf("collector calls after failed tick = %d, want 1", collectCalls)
	}

	fsys.FailAlways("open", filepath.Join(testDir, "system.ring"), syscall.EIO)

	opsBefore := len(fsys.Operations())
	viewsBefore := len(views.views)

	clock.set(testReading(370_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("down Handle(EventTick) error = %v", err)
	}

	if collectCalls != 1 {
		t.Fatalf("collector calls while down = %d, want 1", collectCalls)
	}

	if len(views.views) != viewsBefore+1 {
		t.Fatalf("publish count while down = %d, want %d", len(views.views), viewsBefore+1)
	}

	for _, op := range fsys.Operations()[opsBefore:] {
		if op[0] == "writeat" {
			t.Fatalf("down tick wrote storage: %v", op)
		}
	}

	for _, value := range views.last(t).Window(1, 1)[0] {
		if !math.IsNaN(float64(value)) {
			t.Fatalf("dropped slot value = %v, want NaN", value)
		}
	}
}

func TestRecoveryRerunsStartupProcedure(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})
	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)
	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{4: {4, 5, 6}})
	fsys.FailAlways("writeat", filepath.Join(testDir, "system.ring"), syscall.EIO)

	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}}
	engine, clock, views := startEngine(t, fsys, testBootB, 100, source, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	if !engine.storageDown || !views.last(t).ReplayPending {
		t.Fatal("failed transfer did not leave storage down with replay pending")
	}

	if source.calls() != 0 {
		t.Fatalf("NTP calls before recovery = %d, want 0", source.calls())
	}

	fsys.Heal()
	clock.set(testReading(10_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("recovery Handle(EventTick) error = %v", err)
	}

	if engine.storageDown || views.last(t).ReplayPending {
		t.Fatal("successful startup retry did not clear storage-down and replay-pending state")
	}

	ensureAbsent(t, fsys, pendingPath(testBootA))
	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), 4+offset/180_000, []float32{4, 5, 6})
}

func TestRecoveryReloadsRingFromDisk(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()
	state := timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "saved.pool"}

	seedState(t, fsys, state)

	path := filepath.Join(testDir, "system.ring")

	seedRing(t, fsys, path, ring.SystemSchema(ring.KindHistory), map[int64][]float32{0: {1, 2, 3}})

	engine, clock, _ := startEngine(t, fsys, testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	external, err := ring.Open(fsys, path, ring.SystemSchema(ring.KindHistory), false)
	if err != nil {
		t.Fatalf("external ring.Open() error = %v", err)
	}

	if err := external.Write(0, []float32{9, 8, 7}); err != nil {
		t.Fatalf("external Write() error = %v", err)
	}

	if err := external.Sync(); err != nil {
		t.Fatalf("external Sync() error = %v", err)
	}

	if err := external.Close(); err != nil {
		t.Fatalf("external Close() error = %v", err)
	}

	if got, _ := engine.history.Values(0); got[0] != 1 {
		t.Fatalf("pre-outage in-memory row = %v, want old disk snapshot [1 2 3]", got)
	}

	fsys.FailNext("writeat", path, syscall.EIO)
	clock.set(testReading(190_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("failing Handle(EventTick) error = %v", err)
	}

	clock.set(testReading(200_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("recovery Handle(EventTick) error = %v", err)
	}

	got, ok := engine.history.Values(0)

	if !ok || got[0] != 9 || got[1] != 8 || got[2] != 7 {
		t.Fatalf("reopened in-memory row = %v (present=%t), want disk row [9 8 7]", got, ok)
	}
}

func TestStartupEIORetriesWithoutRecreate(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := filepath.Join(testDir, "system.ring")

	seedRing(t, fsys, path, ring.SystemSchema(ring.KindHistory), map[int64][]float32{3: {3, 4, 5}})

	before := fsys.Bytes(path)

	fsys.FailNext("readat", path, syscall.EIO)

	engine, clock, _ := startEngine(t, fsys, testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	if !engine.storageDown {
		t.Fatal("Start did not retain storage-down state after ring read EIO")
	}

	if got := fsys.Bytes(path); string(got) != string(before) {
		t.Fatal("Start recreated or modified the ring after read EIO")
	}

	clock.set(testReading(10_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("recovery Handle(EventTick) error = %v", err)
	}

	if engine.storageDown {
		t.Fatal("storage stayed down after retrying a transient read EIO")
	}

	requireValues(t, engine.history, 3, []float32{3, 4, 5})
}

func TestOutageSkipsPolls(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})
	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)
	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{0: {1, 2, 3}})
	fsys.FailAlways("writeat", filepath.Join(testDir, "system.ring"), syscall.EIO)

	source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
	engine, clock, _ := startEngine(t, fsys, testBootB, 100, source, nil)

	defer func() { _ = engine.Stop(context.Background()) }()

	if source.calls() != 0 {
		t.Fatalf("NTP calls at failed startup = %d, want 0", source.calls())
	}

	clock.set(testReading(10_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("down Handle(EventTick) error = %v", err)
	}

	if source.calls() != 0 {
		t.Fatalf("NTP calls while storage remained down = %d, want 0", source.calls())
	}

	fsys.Heal()
	clock.set(testReading(20_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("recovery Handle(EventTick) error = %v", err)
	}

	if source.calls() != 1 {
		t.Fatalf("NTP calls after successful reopen = %d, want 1", source.calls())
	}

	ensureAbsent(t, fsys, pendingPath(testBootA))
}

func TestStopIsIdempotent(t *testing.T) {
	fsys := ringtest.NewMemFS()
	engine, _, _ := startEngine(t, fsys, testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	if err := engine.Stop(context.Background()); err != nil {
		t.Fatalf("first Stop() error = %v", err)
	}

	opsAfterFirst := fsys.Operations()

	if err := engine.Stop(context.Background()); err != nil {
		t.Fatalf("second Stop() error = %v", err)
	}

	opsAfterSecond := fsys.Operations()

	if len(opsAfterSecond) != len(opsAfterFirst) {
		t.Fatalf("second Stop touched storage: before %d ops, after %d", len(opsAfterFirst), len(opsAfterSecond))
	}
}

func TestStopSyncsAndCloses(t *testing.T) {
	fsys := ringtest.NewMemFS()
	engine, clock, _ := startEngine(t, fsys, testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	clock.set(testReading(190_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	if engine.currentPending == nil {
		t.Fatal("tick did not create current pending file")
	}

	if err := engine.Stop(context.Background()); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}

	if err := engine.history.Write(1, []float32{1, 2, 3}); err == nil {
		t.Fatal("history ring remained writable after Stop")
	}

	if err := engine.currentPending.Write(1, []float32{1, 2, 3}); err == nil {
		t.Fatal("pending ring remained writable after Stop")
	}

	paths := []string{filepath.Join(testDir, "system.ring"), pendingPath(testBootA)}

	for _, path := range paths {
		if !hasOperation(fsys.Operations(), "sync", path) {
			t.Errorf("Stop did not sync %q", path)
		}

		if !hasOperation(fsys.Operations(), "close", path) {
			t.Errorf("Stop did not close %q", path)
		}
	}

	ops := fsys.Operations()
	lastSync := -1
	firstClose := len(ops)

	for index, op := range ops {
		if op[0] == "sync" && (op[1] == paths[0] || op[1] == paths[1]) {
			lastSync = index
		}

		if op[0] == "close" && (op[1] == paths[0] || op[1] == paths[1]) && firstClose == len(ops) {
			firstClose = index
		}
	}

	if lastSync < 0 || firstClose <= lastSync {
		t.Fatalf("Stop did not sync both files before closing them: ops=%v", ops)
	}
}

func hasOperation(ops [][2]string, name, path string) bool {
	for _, op := range ops {
		if op[0] == name && op[1] == path {
			return true
		}
	}

	return false
}
