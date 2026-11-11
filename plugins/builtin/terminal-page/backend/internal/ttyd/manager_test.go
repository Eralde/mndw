package ttyd

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type fakeTimer struct {
	clock    *fakeClock
	duration time.Duration
	callback func()
	stopped  bool
	fired    bool
}

func (timer *fakeTimer) Stop() bool {
	timer.clock.mu.Lock()

	defer timer.clock.mu.Unlock()

	if timer.stopped || timer.fired {
		return false
	}

	timer.stopped = true

	return true
}

type fakeClock struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

func (clock *fakeClock) AfterFunc(duration time.Duration, callback func()) Timer {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	timer := &fakeTimer{clock: clock, duration: duration, callback: callback}
	clock.timers = append(clock.timers, timer)

	return timer
}

// fire runs the first pending timer with the requested duration and reports
// whether one was found.
func (clock *fakeClock) fire(duration time.Duration) bool {
	clock.mu.Lock()

	var target *fakeTimer

	for _, timer := range clock.timers {
		if !timer.stopped && !timer.fired && timer.duration == duration {
			target = timer

			break
		}
	}

	if target == nil {
		clock.mu.Unlock()

		return false
	}

	target.fired = true

	clock.mu.Unlock()

	target.callback()

	return true
}

// fireStale invokes a timer callback even though Stop already replaced it.
func (clock *fakeClock) fireStale(timer *fakeTimer) {
	clock.mu.Lock()
	timer.fired = true
	clock.mu.Unlock()

	timer.callback()
}

func (clock *fakeClock) last() *fakeTimer {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	if len(clock.timers) == 0 {
		return nil
	}

	return clock.timers[len(clock.timers)-1]
}

func (clock *fakeClock) pending(duration time.Duration) int {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	count := 0

	for _, timer := range clock.timers {
		if !timer.stopped && !timer.fired && timer.duration == duration {
			count++
		}
	}

	return count
}

func testTTYDBinary(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "ttyd")
	script := "#!/bin/sh\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n"

	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	return bin
}

func newTestManager(t *testing.T) (*Manager, *fakeClock) {
	t.Helper()

	clock := &fakeClock{}
	bin := testTTYDBinary(t)
	manager := NewManager(func(name string) string {
		if name == "MNDW_TTYD_BIN" {
			return bin
		}

		return ""
	}, ManagerOptions{AfterFunc: clock.AfterFunc})

	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })

	return manager, clock
}

func TestParseConsoleAcceptsLegacyAliasAndRejectsUnknown(t *testing.T) {
	for input, want := range map[string]Console{
		"":        ConsoleNDMC,
		"ndmc":    ConsoleNDMC,
		"router":  ConsoleNDMC,
		"entware": ConsoleEntware,
	} {
		got, ok := ParseConsole(input)
		if !ok || got != want {
			t.Fatalf("ParseConsole(%q) = (%q, %v), want (%q, true)", input, got, ok, want)
		}
	}

	if _, ok := ParseConsole("serial"); ok {
		t.Fatal("ParseConsole(serial) accepted an unknown console")
	}
}

func TestManagerStartsConsolesIndependently(t *testing.T) {
	manager, _ := newTestManager(t)
	ctx := context.Background()

	if err := manager.Start(ctx, ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if err := manager.Start(ctx, ConsoleEntware); err != nil {
		t.Fatal(err)
	}

	if !manager.Running(ConsoleNDMC) {
		t.Fatal("starting entware stopped ndmc")
	}

	if !manager.Running(ConsoleEntware) {
		t.Fatal("entware is not running")
	}
}

func TestManagerStopsSpawnedConsoleWithoutConnectionsAfterSpawnTimeout(t *testing.T) {
	manager, clock := newTestManager(t)

	if err := manager.Start(context.Background(), ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if clock.pending(SpawnIdleTimeout) != 1 {
		t.Fatalf("pending spawn timers = %d, want 1", clock.pending(SpawnIdleTimeout))
	}

	if !clock.fire(SpawnIdleTimeout) {
		t.Fatal("spawn idle timer did not fire")
	}

	if manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd still running after spawn idle timeout")
	}
}

func TestManagerIgnoresReplacedTimerCallback(t *testing.T) {
	manager, clock := newTestManager(t)
	ctx := context.Background()

	if err := manager.Start(ctx, ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	stale := clock.last()
	if stale == nil {
		t.Fatal("Start() did not schedule a timer")
	}

	if err := manager.Start(ctx, ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if clock.pending(SpawnIdleTimeout) != 1 {
		t.Fatalf("pending spawn timers = %d, want 1", clock.pending(SpawnIdleTimeout))
	}

	clock.fireStale(stale)

	if !manager.Running(ConsoleNDMC) {
		t.Fatal("stale timer callback stopped a freshly spawned console")
	}

	if clock.pending(SpawnIdleTimeout) != 1 {
		t.Fatalf("replaced timer was orphaned: pending spawn timers = %d, want 1", clock.pending(SpawnIdleTimeout))
	}
}

func TestManagerStopsConsoleAfterGracePeriodWhenLastConnectionCloses(t *testing.T) {
	manager, clock := newTestManager(t)

	if err := manager.Start(context.Background(), ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if !manager.Acquire(ConsoleNDMC) {
		t.Fatal("Acquire() = false, want true")
	}

	manager.Release(ConsoleNDMC)

	if clock.pending(GracePeriod) != 1 {
		t.Fatalf("pending grace timers = %d, want 1", clock.pending(GracePeriod))
	}

	if !clock.fire(GracePeriod) {
		t.Fatal("grace timer did not fire")
	}

	if manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd still running after grace period")
	}
}

func TestManagerNewConnectionCancelsGraceStop(t *testing.T) {
	manager, clock := newTestManager(t)

	if err := manager.Start(context.Background(), ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if !manager.Acquire(ConsoleNDMC) {
		t.Fatal("first Acquire() = false, want true")
	}

	manager.Release(ConsoleNDMC)

	if !manager.Acquire(ConsoleNDMC) {
		t.Fatal("second Acquire() = false, want true")
	}

	if clock.fire(GracePeriod) {
		t.Fatal("stopped timer fired after a new connection arrived")
	}

	if !manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd stopped even though a new connection arrived")
	}
}

func TestManagerKeepsConsoleRunningWhileAnotherConnectionRemains(t *testing.T) {
	manager, clock := newTestManager(t)

	if err := manager.Start(context.Background(), ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if !manager.Acquire(ConsoleNDMC) || !manager.Acquire(ConsoleNDMC) {
		t.Fatal("Acquire() = false, want true")
	}

	manager.Release(ConsoleNDMC)

	if clock.pending(GracePeriod) != 0 {
		t.Fatalf("pending grace timers = %d, want 0 while one connection remains", clock.pending(GracePeriod))
	}

	if !manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd stopped while one connection remained")
	}

	manager.Release(ConsoleNDMC)

	if clock.pending(GracePeriod) != 1 {
		t.Fatalf("pending grace timers = %d, want 1 after last release", clock.pending(GracePeriod))
	}
}

func TestManagerStopIfIdleLeavesActiveConsoleRunning(t *testing.T) {
	manager, clock := newTestManager(t)

	if err := manager.Start(context.Background(), ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if !manager.Acquire(ConsoleNDMC) {
		t.Fatal("Acquire() = false, want true")
	}

	if manager.StopIfIdle(ConsoleNDMC) {
		t.Fatal("StopIfIdle() stopped a console with a live connection")
	}

	if !manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd stopped while a connection was live")
	}

	manager.Release(ConsoleNDMC)

	if !manager.StopIfIdle(ConsoleNDMC) {
		t.Fatal("StopIfIdle() = false for an idle console")
	}

	if manager.Running(ConsoleNDMC) {
		t.Fatal("ttyd still running after StopIfIdle()")
	}

	if clock.pending(GracePeriod) != 0 {
		t.Fatalf("pending grace timers = %d, want 0 after an explicit idle stop", clock.pending(GracePeriod))
	}
}

func TestManagerShutdownStopsAllConsoles(t *testing.T) {
	manager, _ := newTestManager(t)
	ctx := context.Background()

	if err := manager.Start(ctx, ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if err := manager.Start(ctx, ConsoleEntware); err != nil {
		t.Fatal(err)
	}

	if !manager.Acquire(ConsoleNDMC) {
		t.Fatal("Acquire() = false, want true")
	}

	if err := manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	if manager.Running(ConsoleNDMC) || manager.Running(ConsoleEntware) {
		t.Fatal("Shutdown() left a console running")
	}

	if manager.Acquire(ConsoleNDMC) {
		t.Fatal("Acquire() succeeded after Shutdown()")
	}

	if err := manager.Start(ctx, ConsoleNDMC); err != errManagerClosed {
		t.Fatalf("Start() after Shutdown() error = %v, want %v", err, errManagerClosed)
	}
}

func TestManagerPortsMatchConsoles(t *testing.T) {
	manager, _ := newTestManager(t)

	if got := manager.Port(ConsoleNDMC); got != "127.0.0.1:7681" {
		t.Fatalf("ndmc port = %q, want 127.0.0.1:7681", got)
	}

	if got := manager.Port(ConsoleEntware); got != "127.0.0.1:7682" {
		t.Fatalf("entware port = %q, want 127.0.0.1:7682", got)
	}
}
