package telemetry

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

type capabilityExecutor struct {
	mu       sync.Mutex
	commands [][]string
	err      error
}

func (e *capabilityExecutor) Run(_ context.Context, args ...string) (rrd.ExecResult, error) {
	e.mu.Lock()

	e.commands = append(e.commands, append([]string(nil), args...))

	e.mu.Unlock()

	return rrd.ExecResult{}, e.err
}

func (e *capabilityExecutor) commandCount() int {
	e.mu.Lock()

	defer e.mu.Unlock()

	return len(e.commands)
}

func TestCapabilityDisabledConstructionDoesNoRRDWork(t *testing.T) {
	executor := &capabilityExecutor{}
	capability, err := NewCapability(CapabilityConfig{
		Executor:       executor,
		RRDDir:         t.TempDir(),
		DesiredEnabled: func() bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}

	if capability.IsEnabled() {
		t.Fatal("disabled capability reports enabled")
	}

	if got := executor.commandCount(); got != 0 {
		t.Fatalf("constructor invoked RRDtool %d times", got)
	}
}

func TestCapabilityDisableCancelsAndJoinsBootRetry(t *testing.T) {
	executor := &capabilityExecutor{err: errors.New("rrdtool unavailable")}
	waitStarted := make(chan struct{})
	waiter := func(ctx context.Context, _ time.Duration) error {
		select {
		case waitStarted <- struct{}{}:
		default:
		}

		<-ctx.Done()

		return ctx.Err()
	}
	capability, err := NewCapability(CapabilityConfig{
		Executor:       executor,
		RRDDir:         t.TempDir(),
		DesiredEnabled: func() bool { return true },
		Wait:           waiter,
		RetryBackoff:   []time.Duration{time.Hour},
	})
	if err != nil {
		t.Fatal(err)
	}

	retryDone := make(chan error, 1)

	go func() { retryDone <- capability.StartWithRetry(context.Background()) }()

	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		t.Fatal("retry did not reach backoff")
	}

	if err := capability.SetEnabled(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-retryDone:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("retry returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("disable returned before retry stopped")
	}
}

type capabilityFakeSampler struct {
	values []rrd.Value
	calls  int
}

func (s *capabilityFakeSampler) Poll(context.Context) ([]rrd.Value, error) {
	s.calls++
	return s.values, nil
}

func testCapabilityConfig(dir string, executor rrd.Executor, clock BootClock) CapabilityConfig {
	return CapabilityConfig{
		Executor:           executor,
		RRDDir:             dir,
		LoadSampler:        &capabilityFakeSampler{values: []rrd.Value{{Known: true, V: 20}, {Known: true, V: 40}}},
		TemperatureSampler: &capabilityFakeSampler{values: []rrd.Value{{Known: true, V: 41000}}},
		Clock:              clock,
		DesiredEnabled:     func() bool { return true },
		Lifetime:           context.Background(),
	}
}

func TestCapabilityEnableInitializesJournalBeforePolling(t *testing.T) {
	dir := t.TempDir()
	executor := &capabilityExecutor{}
	capability, err := NewCapability(testCapabilityConfig(dir, executor, &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = capability.Close(context.Background()) }()

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, "manifest.json")); err != nil {
		t.Fatalf("journal not initialized: %v", err)
	}
	if capability.StorageStatus().Mode != journal.StatusReady {
		t.Fatalf("storage=%+v", capability.StorageStatus())
	}
	// An unanchored boot must not create derived RRD files.
	executor.mu.Lock()
	defer executor.mu.Unlock()
	for _, command := range executor.commands {
		if command[0] == "create" {
			t.Fatalf("unanchored boot created an RRD: %v", command)
		}
	}
}

func TestCapabilityMissingRRDtoolStillAcquires(t *testing.T) {
	dir := t.TempDir()
	executor := &capabilityExecutor{err: errors.New("rrdtool unavailable")}
	capability, err := NewCapability(testCapabilityConfig(dir, executor, &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = capability.Close(context.Background()) }()

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("missing RRDtool blocked acquisition: %v", err)
	}
	if capability.StorageStatus().Mode != journal.StatusReady {
		t.Fatalf("storage=%+v", capability.StorageStatus())
	}
	if capability.pipeline == nil {
		t.Fatal("pipeline not started")
	}
}

func TestCapabilitySetEnabledRollsBackOnFailure(t *testing.T) {
	dir := t.TempDir()
	capability, err := NewCapability(CapabilityConfig{
		Executor:       &capabilityExecutor{},
		RRDDir:         dir,
		Clock:          &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000},
		DesiredEnabled: func() bool { return false },
		Lifetime:       context.Background(),
	})
	if err != nil {
		t.Fatal(err)
	}

	// No samplers configured: enabling must fail and roll back intent.
	if err := capability.SetEnabled(context.Background(), true); err == nil {
		t.Fatal("enable without samplers accepted")
	}
	if capability.IsEnabled() {
		t.Fatal("failed enable left capability enabled")
	}
}

func TestCapabilityDisableJoinsPipelineAndReenableReopens(t *testing.T) {
	dir := t.TempDir()
	capability, err := NewCapability(CapabilityConfig{
		Executor:           &capabilityExecutor{},
		RRDDir:             dir,
		LoadSampler:        &capabilityFakeSampler{values: []rrd.Value{{Known: true, V: 1}, {Known: true, V: 2}}},
		TemperatureSampler: &capabilityFakeSampler{values: []rrd.Value{{Known: true, V: 41000}}},
		Clock:              &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000},
		DesiredEnabled:     func() bool { return true },
		Lifetime:           context.Background(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = capability.Close(context.Background()) }()

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := capability.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if capability.pipeline != nil {
		t.Fatal("disable did not join the pipeline")
	}
	if err := capability.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("reenable: %v", err)
	}
	if capability.StorageStatus().Mode != journal.StatusReady {
		t.Fatalf("storage after reenable=%+v", capability.StorageStatus())
	}
}
