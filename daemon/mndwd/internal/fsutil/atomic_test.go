package fsutil

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteFileAtomicWritesDataAndMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	want := []byte("durable state")

	if err := WriteFileAtomic(path, want, 0o640); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read atomic file: %v", err)
	}

	if string(got) != string(want) {
		t.Fatalf("file contents = %q, want %q", got, want)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat atomic file: %v", err)
	}

	if got := info.Mode().Perm(); got != 0o640 {
		t.Fatalf("file mode = %o, want 640", got)
	}
}

func TestUniqueBackupPathUsesUTCTimestampAndCounter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	at := time.Date(2026, time.November, 19, 14, 30, 0, 0, time.FixedZone("UTC+2", 2*60*60))
	want := filepath.Join(dir, "state.json.bak-20261119T123000Z")

	got, err := UniqueBackupPath(path, at)
	if err != nil {
		t.Fatalf("UniqueBackupPath: %v", err)
	}

	if got != want {
		t.Fatalf("backup path = %q, want %q", got, want)
	}

	if err := os.WriteFile(want, []byte("first backup"), 0o600); err != nil {
		t.Fatalf("create existing backup: %v", err)
	}

	got, err = UniqueBackupPath(path, at)
	if err != nil {
		t.Fatalf("UniqueBackupPath with collision: %v", err)
	}

	if expected := want + "-1"; got != expected {
		t.Fatalf("backup path after collision = %q, want %q", got, expected)
	}
}

func TestWriteFileAtomicRemovesTemporaryFileAfterRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target")

	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}

	if err := WriteFileAtomic(path, []byte("data"), 0o600); err == nil {
		t.Fatal("WriteFileAtomic over a directory succeeded, want rename error")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read temp directory: %v", err)
	}

	if len(entries) != 1 || entries[0].Name() != "target" {
		t.Fatalf("directory entries after failure = %#v, want only target directory", entries)
	}
}
