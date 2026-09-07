package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPathsFromRRDDirDerivesStagingChild(t *testing.T) {
	paths, err := PathsFromRRDDir("/opt/var/lib/mndw/rrd")
	if err != nil {
		t.Fatal(err)
	}
	if paths.JournalDir != filepath.Join(paths.RRDDir, "staging") {
		t.Fatalf("journalDir=%s", paths.JournalDir)
	}
	if filepath.Dir(paths.JournalDir) != paths.RRDDir {
		t.Fatalf("journalDir is not a child: %s", paths.JournalDir)
	}
}

func TestPathsFromRRDDirRejectsEmptyAndRoot(t *testing.T) {
	for _, input := range []string{"", "   ", "/"} {
		if _, err := PathsFromRRDDir(input); !errors.Is(err, ErrInvalidPaths) {
			t.Fatalf("%q accepted: %v", input, err)
		}
	}
}

func TestInitializationPreservesSidecars(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"mndw-load-v1.rrd", "mndw-temp-v1.rrd", "load.annotations.json"} {
		if err := os.WriteFile(filepath.Join(paths.RRDDir, name), []byte("legacy"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != "ready" || opened.Writer == nil {
		t.Fatalf("unexpected recovery: %+v", opened.Status)
	}
	defer opened.Writer.Close()
	if _, err := os.Stat(filepath.Join(paths.JournalDir, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.RRDDir, "load.annotations.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.RRDDir, "mndw-load-v1.rrd")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy RRD not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(paths.RRDDir, "mndw-temp-v1.rrd")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy RRD not removed: %v", err)
	}
}

func TestInitializationIsIdempotentAcrossRestarts(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}

	first, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status.Mode != StatusReady {
		t.Fatalf("first open=%+v", first.Status)
	}
	if err := first.Writer.Close(); err != nil {
		t.Fatal(err)
	}

	// A second open must not repeat the alpha reset or reset retained data.
	if err := os.WriteFile(filepath.Join(paths.RRDDir, "mndw-load-v1.rrd"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Writer.Close()
	if second.Status.Mode != StatusReady {
		t.Fatalf("second open=%+v", second.Status)
	}
	if _, err := os.Stat(filepath.Join(paths.RRDDir, "mndw-load-v1.rrd")); err != nil {
		t.Fatalf("ready storage removed current-format data: %v", err)
	}
}

func TestOpenStorageSalvagesWhenManifestIsLost(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.JournalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeSegmentFixture(t, filepath.Join(paths.JournalDir, "seg-000001.jnl")); err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != StatusReadOnly {
		t.Fatalf("mode=%s issues=%+v", opened.Status.Mode, opened.Status.Issues)
	}
	if opened.Writer != nil {
		t.Fatal("salvage returned a writer")
	}
	if opened.Reader == nil {
		t.Fatal("salvage returned no reader")
	}
	if len(opened.Status.Issues) == 0 || opened.Status.Issues[0].Code != issueManifestLost {
		t.Fatalf("issues=%+v", opened.Status.Issues)
	}
	if err := opened.Reader.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOpenStorageUnavailableWithoutUsableFrames(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.JournalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.JournalDir, "manifest.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != StatusUnavailable || opened.Reader != nil || opened.Writer != nil {
		t.Fatalf("outcome=%+v", opened)
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, "manifest.json")); err != nil {
		t.Fatalf("salvage removed evidence: %v", err)
	}
}

func TestOpenStorageReportsLockContentionAsUnavailable(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}

	first, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status.Mode != StatusReady {
		t.Fatalf("first open=%+v", first.Status)
	}
	defer first.Writer.Close()

	second, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if second.Status.Mode != StatusUnavailable {
		t.Fatalf("second open=%+v", second.Status)
	}
	if len(second.Status.Issues) == 0 || second.Status.Issues[0].Code != issueLockBusy {
		t.Fatalf("issues=%+v", second.Status.Issues)
	}
}

func TestOpenStorageRejectsInvalidArgumentsAndCancellation(t *testing.T) {
	if _, err := OpenStorage(context.Background(), StoragePaths{}, OSFileSystem{}, OSLocker{}, DefaultLimits()); !errors.Is(err, ErrInvalidPaths) {
		t.Fatalf("empty paths: %v", err)
	}
	if _, err := OpenStorage(context.Background(), StoragePaths{RRDDir: "/tmp/x", JournalDir: "/tmp/y"}, OSFileSystem{}, OSLocker{}, DefaultLimits()); !errors.Is(err, ErrInvalidPaths) {
		t.Fatalf("non-child paths: %v", err)
	}

	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := OpenStorage(ctx, paths, OSFileSystem{}, OSLocker{}, DefaultLimits()); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled open: %v", err)
	}
	if _, err := os.Stat(paths.JournalDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled open created storage: %v", err)
	}
}

func TestOpenReadOnlyNeverInitializes(t *testing.T) {
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	result, err := OpenReadOnly(context.Background(), paths, OSFileSystem{}, OSLocker{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status.Mode != StatusReady || result.Reader == nil {
		t.Fatalf("offline inspection=%+v", result.Status)
	}
	if err := result.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.JournalDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only open initialized storage: %v", err)
	}
}

func TestCrashDuringInitializationDoesNotPublishReady(t *testing.T) {
	fs := newCrashFS(t)
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.RRDDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.RRDDir, "mndw-load-v1.rrd"), []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}

	fs.FailAfter("rename", 1)
	opened, err := OpenStorage(context.Background(), paths, fs, &fakeLocker{}, DefaultLimits())
	if err == nil {
		t.Fatalf("initialization crash accepted: %+v", opened.Status)
	}
	if !errors.Is(err, errInjected) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCrashModelDiscardsUnsyncedWrites(t *testing.T) {
	fs := newCrashFS(t)
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := fs.MkdirAll(paths.JournalDir, 0o755); err != nil {
		t.Fatal(err)
	}

	file, err := fs.OpenFile(filepath.Join(paths.JournalDir, "seg-000001.jnl"), os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("unsynced")); err != nil {
		t.Fatal(err)
	}
	fs.Crash()
	if _, err := fs.ReadFile(filepath.Join(paths.JournalDir, "seg-000001.jnl")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unsynced name survived a crash: %v", err)
	}
}

func TestProviderLeaseBlocksReopenUntilReleased(t *testing.T) {
	rrdDir := t.TempDir()
	paths, err := PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := NewStorageProvider(paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = provider.Close(context.Background()) }()

	opened, err := provider.Reopen(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != StatusReady {
		t.Fatalf("reopen=%+v", opened.Status)
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := provider.Reopen(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("reopen during lease: %v", err)
	}
	if provider.CurrentStatus().Mode != StatusReady {
		t.Fatalf("snapshot changed during failed reopen: %+v", provider.CurrentStatus())
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatalf("close is not idempotent: %v", err)
	}

	// A retiring generation refuses new leases until reattachment completes.
	ctxRetire, cancelRetire := context.WithCancel(context.Background())
	cancelRetire()
	if _, err := provider.Reopen(ctxRetire); err == nil {
		t.Fatal("reopen accepted a canceled context")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	reattached, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	if err := reattached.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeSegmentFixture(t *testing.T, path string) error {
	t.Helper()
	header, err := EncodeHeader(Header{Boot: testBootFixture(), SegmentID: 1, BootOrder: 1, FirstSequence: 1})
	if err != nil {
		return err
	}
	prepared, err := PrepareBootStart(BootStart{Boot: testBootFixture(), FirstAcquireElapsedMs: 180000})
	if err != nil {
		return err
	}
	record, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: 1, Payload: prepared.Payload})
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(header, record...), 0o644)
}

func testBootFixture() BootID {
	var boot BootID
	for i := range boot {
		boot[i] = byte(i + 1)
	}
	return boot
}
