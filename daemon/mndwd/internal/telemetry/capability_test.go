package telemetry

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

func TestCapabilityDisabledConstructionDoesNotCreateStorage(t *testing.T) {
	dir := t.TempDir()
	capability, err := NewCapability(CapabilityConfig{
		RRDDir:         dir,
		DesiredEnabled: func() bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}

	if capability.IsEnabled() {
		t.Fatal("disabled capability reports enabled")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(entries) != 0 {
		t.Fatalf("constructor created storage files: %v", entries)
	}
}

func TestNewCapabilityOwnsSnapshotCache(t *testing.T) {
	var configured atomic.Bool
	capability, err := NewCapability(CapabilityConfig{
		RRDDir:         t.TempDir(),
		DesiredEnabled: func() bool { return false },
		SessionConfigured: func() bool {
			return configured.Load()
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	first := capability.SnapshotCache()

	if first == nil {
		t.Fatal("snapshot cache is nil")
	}

	if second := capability.SnapshotCache(); second != first {
		t.Fatal("SnapshotCache returned different instances")
	}

	snapshot, err := first.Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if snapshot.SessionConfigured {
		t.Fatal("SessionConfigured = true before configuration")
	}

	configured.Store(true)

	snapshot, err = first.Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if !snapshot.SessionConfigured {
		t.Fatal("SessionConfigured = false after configuration")
	}
}

func TestCapabilityDisabledStartRestoresRetainedHistory(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	opened, err := journal.OpenStorage(context.Background(), paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	boot := journal.BootID{31}
	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	if err != nil {
		t.Fatal(err)
	}

	sample, err := journal.PrepareSample(journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2,
		Values: []journal.Value{{Known: true, V: 51_000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := opened.Writer.Append(context.Background(), []journal.Record{anchor, sample}); err != nil {
		_ = opened.Writer.Close()

		t.Fatal(err)
	}

	if _, err := opened.Writer.Sync(context.Background()); err != nil {
		_ = opened.Writer.Close()

		t.Fatal(err)
	}

	if err := opened.Writer.Close(); err != nil {
		t.Fatal(err)
	}

	legacyNames := []string{
		"mndw-load-v1.rrd",
		"mndw-temp-v1.rrd",
		"telemetry-derived.checkpoint",
		"telemetry-derived.clean",
	}
	preservedNames := []string{
		"mndw-load-v1.rrd.backup",
		"telemetry-derived.checkpoint.tmp",
		"load.annotations.json",
		"unknown.bin",
	}

	for _, name := range append(legacyNames, preservedNames...) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("legacy"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	var capability *Capability
	fs := &checkingFileSystem{FileSystem: journal.OSFileSystem{}, check: func() {
		snapshot, err := capability.SnapshotCache().Get(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}

		if snapshot == nil || len(snapshot.Keys["temp"].Tiers["fine"].Samples) == 0 {
			t.Fatal("legacy cleanup ran before restored history was published")
		}
	}}

	capability, err = NewCapability(CapabilityConfig{
		RRDDir:         dir,
		FileSystem:     fs,
		DesiredEnabled: func() bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = capability.Close(context.Background()) }()

	if err := capability.StartWithRetry(context.Background()); err != nil {
		t.Fatal(err)
	}

	if capability.pipeline != nil {
		t.Fatal("disabled capability started acquisition")
	}

	assertHistoryValue(t, capability.History(), 1_800_000_000_000, 51_000)

	for _, name := range legacyNames {
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("legacy artifact %s remains: %v", name, err)
		}
	}

	for _, name := range preservedNames {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("cleanup removed preserved file %s: %v", name, err)
		}
	}
}

type checkingFileSystem struct {
	journal.FileSystem
	check      func()
	readDirErr error
}

func (fs *checkingFileSystem) Remove(name string) error {
	if fs.check != nil {
		fs.check()
	}

	return fs.FileSystem.Remove(name)
}

func (fs *checkingFileSystem) ReadDir(name string) ([]os.DirEntry, error) {
	if fs.readDirErr != nil {
		return nil, fs.readDirErr
	}

	return fs.FileSystem.ReadDir(name)
}

func TestCapabilityUnavailableRecoveryPreservesLegacyArtifacts(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(paths.JournalDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(paths.JournalDir, "manifest.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}

	asserted := writeLegacyFiles(t, dir)
	capability, err := NewCapability(CapabilityConfig{RRDDir: dir, DesiredEnabled: func() bool { return false }})
	if err != nil {
		t.Fatal(err)
	}

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if capability.StorageStatus().Mode != journal.StatusUnavailable {
		t.Fatalf("storage=%+v", capability.StorageStatus())
	}

	assertLegacyFilesRemain(t, dir, asserted)
}

func TestCapabilityRecoveryErrorPreservesLegacyArtifacts(t *testing.T) {
	dir := t.TempDir()
	asserted := writeLegacyFiles(t, dir)
	fs := &checkingFileSystem{FileSystem: journal.OSFileSystem{}, readDirErr: errors.New("read directory failed")}
	capability, err := NewCapability(CapabilityConfig{
		RRDDir:         dir,
		FileSystem:     fs,
		DesiredEnabled: func() bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := capability.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	if capability.Status().Error == "" {
		t.Fatal("recovery error missing from diagnostics")
	}

	assertLegacyFilesRemain(t, dir, asserted)
}

func writeLegacyFiles(t *testing.T, dir string) []string {
	t.Helper()

	names := []string{"mndw-load-v1.rrd", "mndw-temp-v1.rrd", "telemetry-derived.checkpoint", "telemetry-derived.clean"}

	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("legacy"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	return names
}

func assertLegacyFilesRemain(t *testing.T, dir string, names []string) {
	t.Helper()

	for _, name := range names {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("recovery removed %s: %v", name, err)
		}
	}
}

func TestCapabilityDisableCancelsAndJoinsBootRetry(t *testing.T) {
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
	values []Value
	calls  int
}

func (s *capabilityFakeSampler) Poll(context.Context) ([]Value, error) {
	s.calls++

	return s.values, nil
}

func testCapabilityConfig(dir string, bootClock clock.BootClock) CapabilityConfig {
	return CapabilityConfig{
		RRDDir:             dir,
		LoadSampler:        &capabilityFakeSampler{values: []Value{{Known: true, V: 20}, {Known: true, V: 40}}},
		TemperatureSampler: &capabilityFakeSampler{values: []Value{{Known: true, V: 41000}}},
		Clock:              bootClock,
		DesiredEnabled:     func() bool { return true },
		Lifetime:           context.Background(),
	}
}

func TestCapabilityEnableInitializesJournalBeforePolling(t *testing.T) {
	dir := t.TempDir()
	capability, err := NewCapability(testCapabilityConfig(dir, &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}))
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

}

func TestCapabilityAcquiresWithoutDerivedOutput(t *testing.T) {
	dir := t.TempDir()
	capability, err := NewCapability(testCapabilityConfig(dir, &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}))
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = capability.Close(context.Background()) }()

	if err := capability.Start(context.Background()); err != nil {
		t.Fatalf("derived output absence blocked acquisition: %v", err)
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
		RRDDir:             dir,
		LoadSampler:        &capabilityFakeSampler{values: []Value{{Known: true, V: 1}, {Known: true, V: 2}}},
		TemperatureSampler: &capabilityFakeSampler{values: []Value{{Known: true, V: 41000}}},
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
