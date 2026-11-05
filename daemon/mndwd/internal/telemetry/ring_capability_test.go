package telemetry

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"mndwd/internal/mgmt"
	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/timekeeper"
)

var _ mgmt.TelemetryController = (*Capability)(nil)

type capabilityClock struct {
	mu      sync.Mutex
	bootID  [16]byte
	reading timekeeper.Reading
}

func (c *capabilityClock) Read() (timekeeper.Reading, error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	return c.reading, nil
}

func (c *capabilityClock) BootID() [16]byte { return c.bootID }

func (c *capabilityClock) set(bootMs int64) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.reading = timekeeper.Reading{
		BootMs: bootMs,
		WallMs: timekeeper.DefaultConfig().MinValidUTC.UnixMilli() + bootMs,
	}
}

type capabilitySampler func(context.Context) ([]Value, error)

func (s capabilitySampler) Poll(ctx context.Context) ([]Value, error) { return s(ctx) }

type capabilityStepper struct {
	clock *capabilityClock
	steps chan int64
}

func newCapabilityStepper(clock *capabilityClock) *capabilityStepper {
	return &capabilityStepper{clock: clock, steps: make(chan int64)}
}

func (s *capabilityStepper) wait(ctx context.Context, _ int64) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case bootMs := <-s.steps:
		s.clock.set(bootMs)

		return nil
	}
}

func (s *capabilityStepper) step(t *testing.T, bootMs int64) {
	t.Helper()

	select {
	case s.steps <- bootMs:
	case <-time.After(time.Second):
		t.Fatal("engine did not wait for a step")
	}
}

func newCapabilityForTest(t *testing.T, config CapabilityConfig) *Capability {
	t.Helper()

	capability, err := NewCapability(config)
	if err != nil {
		t.Fatalf("NewCapability() error = %v", err)
	}

	return capability
}

func TestCapabilityDisabledMissingDirCreatesNothing(t *testing.T) {
	fsys := ringtest.NewMemFS()
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:            "data",
		FS:                fsys,
		Clock:             &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled:    func() bool { return false },
		CheckFS:           func(string) error { return nil },
		SessionConfigured: func() bool { return false },
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	snapshot, err := capability.SnapshotCache().Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Gathering.Enabled {
		t.Fatal("disabled snapshot reports gathering enabled")
	}

	if fsys.Exists(filepath.Join("data", "ring")) {
		t.Fatalf("disabled start created ring storage: ops=%v", fsys.Operations())
	}
}

func TestCapabilitySupportedSeries(t *testing.T) {
	fsys := ringtest.NewMemFS()
	clock := &capabilityClock{bootID: [16]byte{1}}
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:             "data",
		FS:                 fsys,
		Clock:              clock,
		TemperatureSampler: collectorTestSampler{supported: false},
		DesiredEnabled:     func() bool { return false },
		CheckFS:            func(string) error { return nil },
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	snapshot, err := capability.SnapshotCache().Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Keys["temp"].Supported {
		t.Fatal("unsupported thermal sampler marked temp supported")
	}
}

func TestCapabilityDisabledPublishesHistory(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedRingForCapability(t, fsys, filepath.Join("data", "ring", "system.ring"), ring.SystemSchema(ring.KindHistory), map[int64][]float32{0: {12, 37, 42000}})

	clock := &capabilityClock{bootID: [16]byte{1}, reading: timekeeper.Reading{WallMs: 200_000}}
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             fsys,
		Clock:          clock,
		DesiredEnabled: func() bool { return false },
		CheckFS:        func(string) error { return nil },
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	snapshot, err := capability.SnapshotCache().Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Gathering.Enabled {
		t.Fatal("disabled history snapshot reports gathering enabled")
	}

	if !snapshot.Keys["cpu"].Tiers["fine"].Samples[len(snapshot.Keys["cpu"].Tiers["fine"].Samples)-1].OK {
		t.Fatal("disabled snapshot did not publish stored history")
	}
}

func TestCapabilityToggleAndCloseRace(t *testing.T) {
	fsys := ringtest.NewMemFS()
	clock := &capabilityClock{bootID: [16]byte{1}}
	stepper := newCapabilityStepper(clock)
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             fsys,
		Clock:          clock,
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
		Lock:           func(string) (func() error, error) { return func() error { return nil }, nil },
		WaitUntil:      stepper.wait,
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	var wait sync.WaitGroup

	wait.Add(2)

	go func() { defer wait.Done(); <-start; _ = capability.SetEnabled(context.Background(), false) }()

	go func() { defer wait.Done(); <-start; _ = capability.Close(context.Background()) }()

	close(start)
	wait.Wait()

	closeOps := 0

	for _, op := range fsys.Operations() {
		if op[0] == "close" && op[1] == filepath.Join("data", "ring", "system.ring") {
			closeOps++
		}
	}

	if closeOps != 1 {
		t.Fatalf("system.ring close operations = %d, want exactly 1", closeOps)
	}

	before := len(fsys.Operations())

	if err := capability.SetEnabled(context.Background(), true); err == nil {
		t.Fatal("SetEnabled(true) after Close succeeded")
	}

	if got := len(fsys.Operations()); got != before {
		t.Fatalf("SetEnabled(true) after Close started storage work: operations grew from %d to %d", before, got)
	}
}

func TestCapabilityStartsDespiteStorageEIO(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := filepath.Join("data", "ring", "system.ring")
	wallMs := timekeeper.DefaultConfig().MinValidUTC.UnixMilli() + 10_000
	latestSlot := (wallMs-10_000)/int64(ring.SystemSchema(ring.KindHistory).StepMs) - 1

	seedRingForCapability(t, fsys, path, ring.SystemSchema(ring.KindHistory), map[int64][]float32{latestSlot: {11, 22, 33}})
	fsys.FailNext("readat", path, syscall.EIO)

	clock := &capabilityClock{bootID: [16]byte{1}, reading: timekeeper.Reading{WallMs: wallMs}}
	stepper := newCapabilityStepper(clock)
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             fsys,
		Clock:          clock,
		LoadSampler:    collectorTestSampler{values: []Value{{V: 3, Known: true}, {V: 4, Known: true}}, supported: true},
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
		Lock:           func(string) (func() error, error) { return func() error { return nil }, nil },
		WaitUntil:      stepper.wait,
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v, want degraded success", err)
	}

	stepper.step(t, 10_000)
	waitFor(t, func() bool {
		snapshot, _ := capability.SnapshotCache().Get(context.Background(), true)

		return snapshot.Keys["cpu"].Tiers["fine"].Samples[len(snapshot.Keys["cpu"].Tiers["fine"].Samples)-1].OK
	})

	_ = capability.Close(context.Background())
}

func TestCapabilityEnableDisable(t *testing.T) {
	fsys := ringtest.NewMemFS()
	clock := &capabilityClock{bootID: [16]byte{1}}
	stepper := newCapabilityStepper(clock)
	sampled := make(chan struct{}, 4)
	load := capabilitySampler(func(context.Context) ([]Value, error) {
		sampled <- struct{}{}

		return []Value{{V: 12, Known: true}, {V: 34, Known: true}}, nil
	})
	var desired sync.Mutex
	enabled := false
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:      "data",
		FS:          fsys,
		Clock:       clock,
		LoadSampler: load,

		DesiredEnabled: func() bool { desired.Lock(); defer desired.Unlock(); return enabled },
		CheckFS:        func(string) error { return nil },
		Lock:           func(string) (func() error, error) { return func() error { return nil }, nil },
		WaitUntil:      stepper.wait,
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if fsys.Exists(filepath.Join("data", "ring")) {
		t.Fatal("disabled Start created ring storage")
	}

	if err := capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable: %v", err)
	}

	stepper.step(t, 190_000)
	stepper.step(t, 200_000)
	waitForSample(t, sampled)

	if err := capability.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable: %v", err)
	}

	if !hasOperation(fsys.Operations(), "sync", filepath.Join("data", "ring", "pending", "01000000000000000000000000000000.ring")) {
		t.Fatal("disable did not sync current pending ring")
	}

	if err := capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("reenable: %v", err)
	}

	stepper.step(t, 370_000)
	stepper.step(t, 380_000)
	waitForSample(t, sampled)

	if err := capability.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestCapabilityRefusesBlacklistedFS(t *testing.T) {
	fsys := ringtest.NewMemFS()
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             fsys,
		Clock:          &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return ring.ErrUnsupportedFilesystem },
		Lock:           func(string) (func() error, error) { return func() error { return nil }, nil },
	})

	if err := capability.Start(context.Background()); !errors.Is(err, ring.ErrUnsupportedFilesystem) {
		t.Fatalf("Start() error = %v, want unsupported filesystem", err)
	}

	snapshot, err := capability.SnapshotCache().Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Clock == nil || snapshot.Clock.State != "unanchored" {
		t.Fatalf("snapshot clock = %+v, want empty unanchored snapshot", snapshot.Clock)
	}
}

func TestCapabilityLockHeld(t *testing.T) {
	dir := t.TempDir()
	clockOne := &capabilityClock{bootID: [16]byte{1}}
	one := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         dir,
		FS:             ring.OSFS{},
		Clock:          clockOne,
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },

		WaitUntil: func(ctx context.Context, _ int64) error { <-ctx.Done(); return ctx.Err() },
	})

	if err := one.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	clockTwo := &capabilityClock{bootID: [16]byte{2}}
	var waitCalls int
	two := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         dir,
		FS:             ring.OSFS{},
		Clock:          clockTwo,
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
		Wait: func(context.Context, time.Duration) error {
			waitCalls++

			return one.Close(context.Background())
		},

		WaitUntil: func(ctx context.Context, _ int64) error { <-ctx.Done(); return ctx.Err() },
	})

	if err := two.Start(context.Background()); !errors.Is(err, ring.ErrLocked) {
		t.Fatalf("second Start() error = %v, want ErrLocked", err)
	}

	if err := two.StartWithRetry(context.Background()); err != nil {
		t.Fatalf("StartWithRetry() error = %v", err)
	}

	if waitCalls != 1 {
		t.Fatalf("retry waits = %d, want 1", waitCalls)
	}

	_ = two.Close(context.Background())
}

func TestCapabilityLockAcrossToggles(t *testing.T) {
	dir := t.TempDir()
	ringDir := filepath.Join(dir, "ring")

	if err := os.MkdirAll(ringDir, 0o755); err != nil {
		t.Fatal(err)
	}

	clock := &capabilityClock{bootID: [16]byte{1}}
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         dir,
		FS:             ring.OSFS{},
		Clock:          clock,
		DesiredEnabled: func() bool { return false },
		CheckFS:        func(string) error { return nil },

		WaitUntil: func(ctx context.Context, _ int64) error { <-ctx.Done(); return ctx.Err() },
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(ringDir, "lock")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("disabled Start lock stat error = %v, want not-exist", err)
	}

	foreignUnlock, err := ring.Lock(ringDir)
	if err != nil {
		t.Fatal(err)
	}

	if err := capability.SetEnabled(context.Background(), true); !errors.Is(err, ring.ErrLocked) {
		t.Fatalf("enable while locked error = %v, want ErrLocked", err)
	}

	if capability.IsEnabled() {
		t.Fatal("IsEnabled() = true after failed enable")
	}

	if err := foreignUnlock(); err != nil {
		t.Fatal(err)
	}

	if err := capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable after foreign unlock: %v", err)
	}

	second := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         dir,
		FS:             ring.OSFS{},
		Clock:          &capabilityClock{bootID: [16]byte{2}},
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
	})

	if err := second.Start(context.Background()); !errors.Is(err, ring.ErrLocked) {
		t.Fatalf("second enabled capability Start() error = %v, want ErrLocked", err)
	}

	if err := capability.SetEnabled(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	if err := capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable after disable: %v", err)
	}

	if err := capability.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := second.Start(context.Background()); err != nil {
		t.Fatalf("second capability Start() after release: %v", err)
	}

	_ = second.Close(context.Background())
}

func TestCapabilityDisabledRefusesBlacklistedFS(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedRingForCapability(t, fsys, filepath.Join("data", "ring", "system.ring"), ring.SystemSchema(ring.KindHistory), nil)

	reads := 0

	fsys.OnOp(func(op, _ string) {
		if op == "readat" {
			reads++
		}
	})

	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             fsys,
		Clock:          &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled: func() bool { return false },
		CheckFS:        func(string) error { return ring.ErrUnsupportedFilesystem },
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("disabled Start() error = %v", err)
	}

	snapshot, err := capability.SnapshotCache().Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.Gathering.Enabled || reads != 0 {
		t.Fatalf("snapshot gathering=%t, file reads=%d; want disabled empty snapshot and zero reads", snapshot.Gathering.Enabled, reads)
	}
}

func waitForSample(t *testing.T, sampled <-chan struct{}) {
	t.Helper()

	select {
	case <-sampled:
	case <-time.After(time.Second):
		t.Fatal("engine did not collect after stepped tick")
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(time.Second)

	for time.Now().Before(deadline) {
		if condition() {
			return
		}

		time.Sleep(time.Millisecond)
	}

	t.Fatal("condition did not become true")
}

func hasOperation(ops [][2]string, wantOp, wantPath string) bool {
	for _, op := range ops {
		if op[0] == wantOp && op[1] == wantPath {
			return true
		}
	}

	return false
}

func seedRingForCapability(t *testing.T, fsys ring.FS, path string, schema ring.Schema, rows map[int64][]float32) {
	t.Helper()

	if err := fsys.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatal(err)
	}

	for slot, values := range rows {
		if err := stored.Write(slot, values); err != nil {
			t.Fatal(err)
		}
	}

	if err := stored.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := stored.Close(); err != nil {
		t.Fatal(err)
	}

	if err := fsys.SyncDir(filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}
}

func TestCloseReturnsWhenRunIgnoresCancellation(t *testing.T) {
	fixture := newHungCapabilityFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)

	defer cancel()

	result := make(chan error, 1)

	go func() {
		result <- fixture.capability.Close(ctx)
	}()

	err, returned := receiveStopResult(result, time.Second)

	if !returned {
		fixture.release()
		fixture.waitForRun(t)
		<-result
		t.Fatal("Close() did not return after its context expired")
	}

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() error = %v, want context.DeadlineExceeded", err)
	}

	if got := fixture.lockReleases.Load(); got != 0 {
		t.Fatalf("lock releases = %d after timed-out Close(), want 0", got)
	}

	fixture.release()
	fixture.waitForRun(t)
}

func TestSetEnabledFalseDoesNotBlockIsEnabled(t *testing.T) {
	fixture := newHungCapabilityFixture(t)
	result := make(chan error, 1)
	started := make(chan struct{})

	go func() {
		close(started)

		result <- fixture.capability.SetEnabled(context.Background(), false)
	}()

	<-started

	probe := make(chan bool, 1)

	go func() {
		deadline := time.Now().Add(200 * time.Millisecond)

		for time.Now().Before(deadline) {
			if !fixture.capability.IsEnabled() {
				probe <- true

				return
			}

			time.Sleep(time.Millisecond)
		}

		probe <- false
	}()

	select {
	case disabled := <-probe:
		if !disabled {
			fixture.release()
			fixture.waitForRun(t)
			<-result
			t.Fatal("IsEnabled() did not report false while disable was waiting")
		}
	case <-time.After(200 * time.Millisecond):
		fixture.release()
		fixture.waitForRun(t)
		<-result
		t.Fatal("IsEnabled() blocked while disable was waiting")
	}

	select {
	case err := <-result:
		t.Fatalf("SetEnabled(false) returned before the run stopped: %v", err)
	default:
	}

	fixture.release()
	fixture.waitForRun(t)

	if err := <-result; err != nil {
		t.Fatalf("SetEnabled(false) error after run stopped = %v", err)
	}
}

func TestSetEnabledFalseTimesOutAndAcceptsDisable(t *testing.T) {
	fixture := newHungCapabilityFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)

	defer cancel()

	result := make(chan error, 1)

	go func() {
		result <- fixture.capability.SetEnabled(ctx, false)
	}()

	err, returned := receiveStopResult(result, time.Second)

	if !returned {
		fixture.release()
		fixture.waitForRun(t)
		<-result
		t.Fatal("SetEnabled(false) did not return after its context expired")
	}

	if err != nil {
		t.Fatalf("SetEnabled(false) error = %v, want nil after timeout", err)
	}

	if fixture.capability.IsEnabled() {
		t.Fatal("IsEnabled() = true after timed-out disable")
	}

	select {
	case <-fixture.done:
		t.Fatal("run stopped before the test released WaitUntil")
	default:
	}

	fixture.release()
	fixture.waitForRun(t)
}

func TestSetEnabledTrueRefusedWhileStopping(t *testing.T) {
	fixture := newHungCapabilityFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)

	defer cancel()

	result := make(chan error, 1)

	go func() {
		result <- fixture.capability.SetEnabled(ctx, false)
	}()

	if err, returned := receiveStopResult(result, time.Second); !returned || err != nil {
		fixture.release()
		fixture.waitForRun(t)

		if !returned {
			<-result
		}

		t.Fatalf("SetEnabled(false) = %v, returned=%t; want nil before run exits", err, returned)
	}

	if err := fixture.capability.SetEnabled(context.Background(), true); !errors.Is(err, errTelemetryStopping) {
		t.Fatalf("SetEnabled(true) while stopping error = %v, want errTelemetryStopping", err)
	}

	if fixture.capability.IsEnabled() {
		t.Fatal("IsEnabled() = true after refusing enable while stopping")
	}

	fixture.release()
	fixture.waitForRun(t)

	if err := fixture.capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetEnabled(true) after run stopped error = %v, want nil", err)
	}
}

func TestCloseAfterTimedOutDisableDoesNotHang(t *testing.T) {
	fixture := newHungCapabilityFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)

	defer cancel()

	disabled := make(chan error, 1)

	go func() {
		disabled <- fixture.capability.SetEnabled(ctx, false)
	}()

	if err, returned := receiveStopResult(disabled, time.Second); !returned || err != nil {
		fixture.release()
		fixture.waitForRun(t)

		if !returned {
			<-disabled
		}

		t.Fatalf("SetEnabled(false) = %v, returned=%t; want nil before run exits", err, returned)
	}

	closeCtx, closeCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)

	defer closeCancel()

	closed := make(chan error, 1)

	go func() {
		closed <- fixture.capability.Close(closeCtx)
	}()

	err, returned := receiveStopResult(closed, time.Second)

	if !returned {
		fixture.release()
		fixture.waitForRun(t)
		<-closed
		t.Fatal("Close() after timed-out disable did not return after its context expired")
	}

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() error = %v, want context.DeadlineExceeded", err)
	}

	if got := fixture.lockReleases.Load(); got != 0 {
		t.Fatalf("lock releases = %d after timed-out Close(), want 0", got)
	}

	fixture.release()
	fixture.waitForRun(t)
}

type hungCapabilityFixture struct {
	capability   *Capability
	done         <-chan struct{}
	entered      chan struct{}
	releaseChan  chan struct{}
	releaseOnce  sync.Once
	lockReleases atomic.Int32
}

func newHungCapabilityFixture(t *testing.T) *hungCapabilityFixture {
	t.Helper()

	fixture := &hungCapabilityFixture{
		releaseChan: make(chan struct{}),
		entered:     make(chan struct{}),
	}
	var enteredOnce sync.Once
	capability := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "data",
		FS:             ringtest.NewMemFS(),
		Clock:          &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
		Lock: func(string) (func() error, error) {
			return func() error {
				fixture.lockReleases.Add(1)

				return nil
			}, nil
		},
		WaitUntil: func(context.Context, int64) error {
			enteredOnce.Do(func() { close(fixture.entered) })
			<-fixture.releaseChan

			return context.Canceled
		},
	})

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	capability.mu.Lock()

	fixture.done = capability.runDone

	capability.mu.Unlock()

	fixture.capability = capability

	t.Cleanup(func() {
		fixture.release()
		fixture.waitForRun(t)

		if err := capability.Close(context.Background()); err != nil {
			t.Errorf("cleanup Close() error = %v", err)
		}
	})

	select {
	case <-fixture.entered:
	case <-time.After(time.Second):
		t.Fatal("run did not enter the cancellation-ignoring WaitUntil")
	}

	return fixture
}

func (fixture *hungCapabilityFixture) release() {
	fixture.releaseOnce.Do(func() { close(fixture.releaseChan) })
}

func (fixture *hungCapabilityFixture) waitForRun(t *testing.T) {
	t.Helper()

	select {
	case <-fixture.done:
	case <-time.After(time.Second):
		t.Fatal("telemetry run did not stop after release")
	}
}

func receiveStopResult(result <-chan error, timeout time.Duration) (error, bool) {
	select {
	case err := <-result:
		return err, true
	case <-time.After(timeout):
		return nil, false
	}
}
