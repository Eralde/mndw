package telemetry

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"mndwd/internal/telemetry/ring/ringtest"
)

func TestCleanupJournalArtifactsExactNames(t *testing.T) {
	fsys := ringtest.NewMemFS()
	rrdDir := "rrd"
	staging := filepath.Join(rrdDir, "staging")

	for _, name := range []string{
		"seg-00000001.jnl",
		"manifest.json",
		".manifest.json.tmp",
		"journal.lock",
	} {
		writeCleanupFile(t, fsys, filepath.Join(staging, name))
	}

	writeCleanupFile(t, fsys, filepath.Join(staging, "notes.txt"))
	writeCleanupFile(t, fsys, filepath.Join(rrdDir, "notes.txt"))

	for _, name := range []string{
		"mndw-load-v1.rrd",
		"mndw-temp-v1.rrd",
		"telemetry-derived.checkpoint",
		"telemetry-derived.clean",
	} {
		writeCleanupFile(t, fsys, filepath.Join(rrdDir, name))
	}

	if err := cleanupJournalArtifacts(fsys, rrdDir); err != nil {
		t.Fatalf("cleanupJournalArtifacts() error = %v", err)
	}

	if !fsys.Exists(filepath.Join(staging, "notes.txt")) || !fsys.Exists(filepath.Join(rrdDir, "notes.txt")) {
		t.Fatal("cleanup removed an unrelated file")
	}

	if !fsys.Exists(staging) {
		t.Fatal("cleanup removed non-empty staging directory")
	}

	for _, name := range []string{
		"seg-00000001.jnl",
		"manifest.json",
		".manifest.json.tmp",
		"journal.lock",
		"mndw-load-v1.rrd",
		"mndw-temp-v1.rrd",
		"telemetry-derived.checkpoint",
		"telemetry-derived.clean",
	} {
		if fsys.Exists(filepath.Join(rrdDir, name)) || fsys.Exists(filepath.Join(staging, name)) {
			t.Errorf("cleanup left legacy artifact %q", name)
		}
	}

	if err := fsys.Remove(filepath.Join(staging, "notes.txt")); err != nil {
		t.Fatal(err)
	}

	if err := cleanupJournalArtifacts(fsys, rrdDir); err != nil {
		t.Fatalf("cleanupJournalArtifacts() second call error = %v", err)
	}

	if fsys.Exists(staging) {
		t.Fatal("cleanup left empty staging directory")
	}

	if err := cleanupJournalArtifacts(fsys, rrdDir); err != nil {
		t.Fatalf("cleanupJournalArtifacts() third call error = %v", err)
	}
}

func TestCleanupRunsOnEnabledStartOnly(t *testing.T) {
	fsys := ringtest.NewMemFS()

	seedCleanupArtifacts(t, fsys, "rrd")

	disabled := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "rrd",
		FS:             fsys,
		Clock:          &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled: func() bool { return false },
		CheckFS:        func(string) error { return nil },
	})

	if err := disabled.Start(context.Background()); err != nil {
		t.Fatalf("disabled Start() error = %v", err)
	}

	if !fsys.Exists(filepath.Join("rrd", "staging", "manifest.json")) || !fsys.Exists(filepath.Join("rrd", "mndw-load-v1.rrd")) {
		t.Fatal("disabled Start() removed legacy artifacts")
	}

	enabled := newCapabilityForTest(t, CapabilityConfig{
		RRDDir:         "rrd",
		FS:             fsys,
		Clock:          &capabilityClock{bootID: [16]byte{1}},
		DesiredEnabled: func() bool { return true },
		CheckFS:        func(string) error { return nil },
		Lock:           func(string) (func() error, error) { return func() error { return nil }, nil },
		WaitUntil: func(ctx context.Context, _ int64) error {
			<-ctx.Done()

			return ctx.Err()
		},
	})

	if err := enabled.Start(context.Background()); err != nil {
		t.Fatalf("enabled Start() error = %v", err)
	}

	t.Cleanup(func() {
		if err := enabled.Close(context.Background()); err != nil {
			t.Errorf("enabled Close() error = %v", err)
		}
	})

	if fsys.Exists(filepath.Join("rrd", "staging", "manifest.json")) || fsys.Exists(filepath.Join("rrd", "mndw-load-v1.rrd")) {
		t.Fatal("enabled Start() left legacy artifacts")
	}
}

func seedCleanupArtifacts(t *testing.T, fsys *ringtest.MemFS, rrdDir string) {
	t.Helper()
	writeCleanupFile(t, fsys, filepath.Join(rrdDir, "staging", "manifest.json"))
	writeCleanupFile(t, fsys, filepath.Join(rrdDir, "mndw-load-v1.rrd"))
}

func writeCleanupFile(t *testing.T, fsys *ringtest.MemFS, path string) {
	t.Helper()

	if err := fsys.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	file, err := fsys.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	if n, err := file.WriteAt([]byte("legacy"), 0); err != nil || n != len("legacy") {
		t.Fatalf("WriteAt(%q) = (%d, %v), want (%d, nil)", path, n, err, len("legacy"))
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
