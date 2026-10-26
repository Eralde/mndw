package system

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

func TestUnanchoredTicksWriteBootSlotsToPending(t *testing.T) {
	fsys := ringtest.NewMemFS()
	source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}}
	var collected int32
	collect := func(context.Context) []float32 {
		collected++

		return []float32{float32(collected), 40, 42000}
	}
	engine, clock, views := startEngine(t, fsys, testBootA, 0, source, collect)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	for slot := int64(0); slot < 3; slot++ {
		bootMs := (slot+1)*180_000 + 10_000

		clock.set(testReading(bootMs))

		if err := engine.Handle(context.Background(), EventTick); err != nil {
			t.Fatalf("Handle(EventTick) error = %v", err)
		}
	}

	stored := readRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending))

	for slot := int64(0); slot < 3; slot++ {
		requireValues(t, stored, slot, []float32{float32(slot + 1), 40, 42000})
	}

	history := readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory))

	if history.HasRows() {
		t.Fatal("unanchored ticks wrote rows to the history ring")
	}

	view := views.last(t)

	if view.Anchored || view.ReplayPending {
		t.Fatalf("view = {Anchored:%t ReplayPending:%t}, want both false", view.Anchored, view.ReplayPending)
	}

	if source.calls() != 4 {
		t.Fatalf("NTP calls = %d, want startup plus 3 tick polls", source.calls())
	}
}

func TestReplayPendingOnlyWithKnownOffset(t *testing.T) {
	for _, tt := range []struct {
		name        string
		stateBoot   [16]byte
		pendingBoot [16]byte
		failWrite   bool
		wantReplay  bool
	}{
		{name: "matching previous boot transfer fails", stateBoot: testBootA, pendingBoot: testBootA, failWrite: true, wantReplay: true},
		{name: "foreign pending is deleted", stateBoot: testBootA, pendingBoot: testBootC, wantReplay: false},
		{name: "current pending waiting for NTP", pendingBoot: testBootB, wantReplay: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fsys := ringtest.NewMemFS()

			seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

			if tt.stateBoot != ([16]byte{}) {
				seedState(t, fsys, timekeeper.State{BootID: tt.stateBoot, OffsetMs: timekeeper.DefaultConfig().MinValidUTC.UnixMilli(), Server: "pool.ntp.org"})
			}

			seedRing(t, fsys, pendingPath(tt.pendingBoot), ring.SystemSchema(ring.KindPending), map[int64][]float32{5: {1, 2, 3}})

			if tt.failWrite {
				fsys.FailNext("writeat", filepath.Join(testDir, "system.ring"), syscall.EIO)
			}

			source := &fakeNTP{bodies: [][]byte{invalidNTPBody()}}
			engine, _, views := startEngine(t, fsys, testBootB, 100, source, nil)

			t.Cleanup(func() { _ = engine.Stop(context.Background()) })

			if got := views.last(t).ReplayPending; got != tt.wantReplay {
				t.Fatalf("ReplayPending = %t, want %t", got, tt.wantReplay)
			}
		})
	}
}

func TestPendingCreatedLazily(t *testing.T) {
	fsys := ringtest.NewMemFS()
	source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
	engine, _, views := startEngine(t, fsys, testBootA, 100_000, source, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	if !views.last(t).Anchored {
		t.Fatal("valid startup evidence did not anchor the engine")
	}

	ensureAbsent(t, fsys, pendingPath(testBootA))
}

func TestAcceptanceWritesStateThenTransfers(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

	source := &fakeNTP{bodies: [][]byte{invalidNTPBody(), validNTPBody()}}
	engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, func(context.Context) []float32 {
		return []float32{12.5, 37.75, 42000}
	})

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	startOps := len(fsys.Operations())

	const bootMs = int64(190_000)

	clock.set(testReading(bootMs))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	ops := fsys.Operations()[startOps:]
	stateWrite, rename, stateSyncDir, ringWrite := -1, -1, -1, -1

	for index, op := range ops {
		switch {
		case op[0] == "writeat" && op[1] == filepath.Join(testDir, "clock.state.tmp") && stateWrite < 0:
			stateWrite = index
		case op[0] == "rename" && op[1] == filepath.Join(testDir, "clock.state.tmp") && rename < 0:
			rename = index
		case op[0] == "syncdir" && op[1] == testDir && stateSyncDir < 0:
			stateSyncDir = index
		case op[0] == "writeat" && op[1] == filepath.Join(testDir, "system.ring") && ringWrite < 0:
			ringWrite = index
		}
	}

	if stateWrite < 0 || rename < 0 || stateSyncDir < 0 || ringWrite < 0 || !(stateWrite < rename && rename < stateSyncDir && stateSyncDir < ringWrite) {
		t.Fatalf("clock.state persistence must precede transfer row write; operation indices = write %d, rename %d, syncdir %d, ring write %d; ops=%v", stateWrite, rename, stateSyncDir, ringWrite, ops)
	}

	ensureAbsent(t, fsys, pendingPath(testBootA))

	state, err := timekeeper.DecodeState(fsys.Bytes(filepath.Join(testDir, "clock.state")))
	if err != nil {
		t.Fatalf("DecodeState(clock.state) error = %v", err)
	}

	if !viewsAnchored(engine) {
		t.Fatal("engine did not anchor after durable state write and transfer")
	}

	transferSlot := int64(0) + state.OffsetMs/180_000

	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), transferSlot, []float32{12.5, 37.75, 42000})
}

func TestAnchoredTickGrid(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "pool.ntp.org"})

	start := (offset/180_000)*180_000 + 100_000
	engine, clock, _ := startEngine(t, fsys, testBootA, start, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, func(context.Context) []float32 {
		return []float32{20, 40, 42500}
	})

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	slot := int64(7)
	tickBoot := (slot+1)*180_000 + 10_000 - offset

	if tickBoot <= 0 {
		slot = offset / 180_000
		tickBoot = (slot+1)*180_000 + 10_000 - offset
	}

	clock.set(testReading(tickBoot))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), slot, []float32{20, 40, 42500})
}

func TestStateWriteFailureDefersAcceptance(t *testing.T) {
	fsys := ringtest.NewMemFS()

	fsys.FailNext("rename", filepath.Join(testDir, "clock.state.tmp"), syscall.EIO)

	source := &fakeNTP{bodies: [][]byte{invalidNTPBody(), validNTPBody(), validNTPBody()}}
	engine, clock, views := startEngine(t, fsys, testBootA, 0, source, func(context.Context) []float32 {
		return []float32{3, 4, 5}
	})

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	clock.set(testReading(190_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	if views.last(t).Anchored {
		t.Fatal("failed clock.state rename accepted evidence")
	}

	ensureAbsent(t, fsys, filepath.Join(testDir, "clock.state"))

	if !fsys.Exists(pendingPath(testBootA)) {
		t.Fatal("pending file was removed after failed state write")
	}

	clock.set(testReading(370_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("recovery Handle(EventTick) error = %v", err)
	}

	if !views.last(t).Anchored {
		t.Fatal("valid evidence was not accepted after reopening storage")
	}
}

func TestStartupClassifiesStateAndPendingErrors(t *testing.T) {
	t.Run("missing state allows foreign cleanup", func(t *testing.T) {
		fsys := ringtest.NewMemFS()

		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{1: {1, 2, 3}})

		engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		ensureAbsent(t, fsys, pendingPath(testBootA))
	})

	t.Run("bad state treated as absent", func(t *testing.T) {
		fsys := ringtest.NewMemFS()

		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{1: {1, 2, 3}})

		if err := fsys.MkdirAll(testDir, 0o755); err != nil {
			t.Fatal(err)
		}

		file, err := fsys.OpenFile(filepath.Join(testDir, "clock.state"), os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}

		_, _ = file.WriteAt([]byte("bad"), 0)
		_ = file.Close()
		engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		ensureAbsent(t, fsys, pendingPath(testBootA))
	})

	t.Run("state read EIO preserves pending", func(t *testing.T) {
		fsys := ringtest.NewMemFS()

		seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: 1_800_000_000_000, Server: "pool.ntp.org"})
		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{1: {1, 2, 3}})
		fsys.FailNext("readat", filepath.Join(testDir, "clock.state"), syscall.EIO)

		engine, _, views := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })

		if !fsys.Exists(pendingPath(testBootA)) {
			t.Fatal("pending file was removed after clock.state read EIO")
		}

		if views.last(t).Anchored {
			t.Fatal("engine anchored after clock.state read EIO")
		}
	})

	t.Run("pending readdir EIO preserves pending", func(t *testing.T) {
		fsys := ringtest.NewMemFS()

		seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: 1_800_000_000_000, Server: "pool.ntp.org"})
		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{1: {1, 2, 3}})

		pendingDir := filepath.Join(testDir, "pending")

		fsys.FailNext("readdir", pendingDir, syscall.EIO)

		engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })

		if !fsys.Exists(pendingPath(testBootA)) {
			t.Fatal("pending file was removed after pending directory read EIO")
		}
	})

	t.Run("missing pending dir is empty", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })

		if !fsys.Exists(filepath.Join(testDir, "pending")) {
			t.Fatal("enabled Start did not create pending directory")
		}
	})

	t.Run("invalid previous pending is deleted", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		path := pendingPath(testBootA)

		if err := fsys.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}

		file, err := fsys.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}

		_, _ = file.WriteAt([]byte("invalid"), 0)
		_ = file.Close()

		if err := fsys.SyncDir(filepath.Dir(path)); err != nil {
			t.Fatal(err)
		}

		engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		ensureAbsent(t, fsys, path)
	})
}

func TestTransferOverwritesOccupiedSlot(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()
	target := int64(5) + offset/180_000

	seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), map[int64][]float32{target: {9, 9, 9}})
	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{5: {1, 2, 3}})
	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "pool.ntp.org"})

	engine, _, _ := startEngine(t, fsys, testBootB, 10_000, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), target, []float32{1, 2, 3})
}

func TestTransferIgnoresNowSlot(t *testing.T) {
	fsys := ringtest.NewMemFS()
	offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()

	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{14_399: {4, 5, 6}})
	seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "pool.ntp.org"})

	engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	target := int64(14_399) + offset/180_000

	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), target, []float32{4, 5, 6})
}

func TestStartAnchoredFromCurrentBootState(t *testing.T) {
	fsys := ringtest.NewMemFS()
	state := timekeeper.State{BootID: testBootA, OffsetMs: 1_800_000_000_000, Server: "saved.pool", SyncStartBootMs: 123}
	stateBytes := seedState(t, fsys, state)
	source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
	engine, _, views := startEngine(t, fsys, testBootA, 90_000, source, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	if !views.last(t).Anchored {
		t.Fatal("current-boot clock.state did not restore anchored state")
	}

	if source.calls() != 0 {
		t.Fatalf("NTP calls = %d, want 0 for restored anchored state", source.calls())
	}

	if got := fsys.Bytes(filepath.Join(testDir, "clock.state")); string(got) != string(stateBytes) {
		t.Fatal("Start rewrote state using the moved wall clock")
	}
}

func TestStartTransfersPreviousBootPendingBeforeAcceptance(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()
		state := timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"}
		stateBytes := seedState(t, fsys, state)

		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{7: {7, 8, 9}})

		engine, _, views := startEngine(t, fsys, testBootB, 100, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		ensureAbsent(t, fsys, pendingPath(testBootA))

		if views.last(t).Anchored {
			t.Fatal("previous-boot state anchored the current boot")
		}

		if got := fsys.Bytes(filepath.Join(testDir, "clock.state")); string(got) != string(stateBytes) {
			t.Fatal("startup transfer rewrote clock.state")
		}

		transferredSlot := int64(7) + offset/180_000

		requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), transferredSlot, []float32{7, 8, 9})
	})

	t.Run("failed transfer blocks polls until recovery repeats startup", func(t *testing.T) {
		fsys := ringtest.NewMemFS()
		offset := timekeeper.DefaultConfig().MinValidUTC.UnixMilli()
		stateBytes := seedState(t, fsys, timekeeper.State{BootID: testBootA, OffsetMs: offset, Server: "old.pool"})

		seedRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory), nil)
		seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{7: {7, 8, 9}})
		fsys.FailNext("writeat", filepath.Join(testDir, "system.ring"), syscall.EIO)

		source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
		engine, clock, views := startEngine(t, fsys, testBootB, 100, source, nil)

		t.Cleanup(func() { _ = engine.Stop(context.Background()) })

		if source.calls() != 0 {
			t.Fatalf("NTP calls at failed Start = %d, want 0", source.calls())
		}

		if views.last(t).Anchored {
			t.Fatal("failed previous-boot transfer anchored the current boot")
		}

		if got := fsys.Bytes(filepath.Join(testDir, "clock.state")); string(got) != string(stateBytes) {
			t.Fatal("failed transfer changed clock.state")
		}

		if !fsys.Exists(pendingPath(testBootA)) {
			t.Fatal("failed transfer removed previous-boot pending file")
		}

		fsys.FailNext("open", filepath.Join(testDir, "system.ring"), syscall.EIO)
		clock.set(testReading(10_000))

		if err := engine.Handle(context.Background(), EventTick); err != nil {
			t.Fatalf("down Handle(EventTick) error = %v", err)
		}

		if source.calls() != 0 {
			t.Fatalf("NTP calls during failed reopen = %d, want 0", source.calls())
		}

		if got := fsys.Bytes(filepath.Join(testDir, "clock.state")); string(got) != string(stateBytes) {
			t.Fatal("down tick changed clock.state")
		}

		if views.last(t).Anchored || !fsys.Exists(pendingPath(testBootA)) {
			t.Fatal("down tick changed anchoring or pending state")
		}

		source.called = func() {
			if fsys.Exists(pendingPath(testBootA)) {
				t.Error("NTP evidence was requested before previous-boot transfer completed")
			}
		}

		clock.set(testReading(20_000))

		if err := engine.Handle(context.Background(), EventTick); err != nil {
			t.Fatalf("recovery Handle(EventTick) error = %v", err)
		}

		if source.calls() != 1 {
			t.Fatalf("NTP calls after successful reopen = %d, want 1 after transfer", source.calls())
		}

		ensureAbsent(t, fsys, pendingPath(testBootA))

		if !views.last(t).Anchored {
			t.Fatal("valid evidence was not accepted after recovery transfer")
		}

		if got := fsys.Bytes(filepath.Join(testDir, "clock.state")); string(got) == string(stateBytes) {
			t.Fatal("clock.state was not updated after transfer completed and evidence was accepted")
		}

		transferredSlot := int64(7) + offset/180_000

		requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), transferredSlot, []float32{7, 8, 9})

		if engine.storageDown {
			t.Fatal("engine remained storage down after successful reopen")
		}
	})
}

func TestStartUnanchoredPollsImmediately(t *testing.T) {
	fsys := ringtest.NewMemFS()
	source := &fakeNTP{bodies: [][]byte{validNTPBody()}}
	engine, _, views := startEngine(t, fsys, testBootA, 100_000, source, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	if source.calls() != 1 {
		t.Fatalf("NTP calls at Start = %d, want 1", source.calls())
	}

	if !views.last(t).Anchored {
		t.Fatal("valid startup evidence was not accepted")
	}
}

func TestStartDeletesForeignPending(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), nil)
	seedRing(t, fsys, filepath.Join(testDir, "pending", "not-a-boot-id.ring"), ring.SystemSchema(ring.KindPending), nil)

	engine, _, _ := startEngine(t, fsys, testBootB, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, nil)

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	ensureAbsent(t, fsys, pendingPath(testBootA))

	if !fsys.Exists(filepath.Join(testDir, "pending", "not-a-boot-id.ring")) {
		t.Fatal("Start removed a pending filename outside the 32-hex pattern")
	}
}

func TestStartReusesCurrentBootPending(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending), map[int64][]float32{10: {1, 2, 3}})

	engine, clock, _ := startEngine(t, fsys, testBootA, 0, &fakeNTP{bodies: [][]byte{invalidNTPBody()}}, func(context.Context) []float32 {
		return []float32{4, 5, 6}
	})

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	clock.set(testReading((11+1)*180_000 + 10_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("Handle(EventTick) error = %v", err)
	}

	stored := readRing(t, fsys, pendingPath(testBootA), ring.SystemSchema(ring.KindPending))

	requireValues(t, stored, 10, []float32{1, 2, 3})
	requireValues(t, stored, 11, []float32{4, 5, 6})
}

func TestGridSwitchOverwritesOrSkipsOneSlot(t *testing.T) {
	fsys := ringtest.NewMemFS()
	source := &fakeNTP{bodies: [][]byte{invalidNTPBody(), validNTPBody(), invalidNTPBody()}}
	engine, clock, _ := startEngine(t, fsys, testBootA, 0, source, func(context.Context) []float32 {
		return []float32{1, 2, 3}
	})

	t.Cleanup(func() { _ = engine.Stop(context.Background()) })

	const firstBootMs = int64(190_000)

	clock.set(testReading(firstBootMs))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("acceptance tick error = %v", err)
	}

	state, err := timekeeper.DecodeState(fsys.Bytes(filepath.Join(testDir, "clock.state")))
	if err != nil {
		t.Fatalf("DecodeState error = %v", err)
	}

	oldSlot := firstBootMs/180_000 - 1 + state.OffsetMs/180_000
	newSlot := (firstBootMs+state.OffsetMs-10_000)/180_000 - 1

	if newSlot < oldSlot || newSlot > oldSlot+1 {
		t.Fatalf("grid switch moved from old slot %d to %d; want overwrite or one empty slot", oldSlot, newSlot)
	}

	clock.set(testReading(firstBootMs + 180_000))

	if err := engine.Handle(context.Background(), EventTick); err != nil {
		t.Fatalf("post-acceptance tick error = %v", err)
	}

	requireValues(t, readRing(t, fsys, filepath.Join(testDir, "system.ring"), ring.SystemSchema(ring.KindHistory)), newSlot, []float32{1, 2, 3})
}

func viewsAnchored(engine *Engine) bool {
	return engine != nil && engine.keeper != nil && func() bool {
		_, anchored := engine.keeper.Anchored()

		return anchored
	}()
}
