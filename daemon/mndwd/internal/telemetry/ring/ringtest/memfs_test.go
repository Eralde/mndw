package ringtest

import (
	"os"
	"testing"

	"mndwd/internal/telemetry/ring"
)

func TestMemFSCrashRevertsUnsynced(t *testing.T) {
	t.Run("unsynced write is lost", func(t *testing.T) {
		fsys := NewMemFS()
		file := durableTestFile(t, fsys, "ring.data", "old")

		if _, err := file.WriteAt([]byte("new"), 0); err != nil {
			t.Fatal(err)
		}

		fsys.Crash()

		if got := string(fsys.Bytes("ring.data")); got != "old" {
			t.Fatalf("bytes after crash = %q, want old", got)
		}
	})

	t.Run("synced write survives", func(t *testing.T) {
		fsys := NewMemFS()
		file := durableTestFile(t, fsys, "ring.data", "old")

		if _, err := file.WriteAt([]byte("new"), 0); err != nil {
			t.Fatal(err)
		}

		if err := file.Sync(); err != nil {
			t.Fatal(err)
		}

		fsys.Crash()

		if got := string(fsys.Bytes("ring.data")); got != "new" {
			t.Fatalf("bytes after crash = %q, want new", got)
		}
	})

	t.Run("unsynced create name is lost", func(t *testing.T) {
		fsys := NewMemFS()

		if err := fsys.MkdirAll("ring", 0o755); err != nil {
			t.Fatal(err)
		}

		if err := fsys.SyncDir("."); err != nil {
			t.Fatal(err)
		}

		file, err := fsys.OpenFile("ring/new.data", os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := file.WriteAt([]byte("new"), 0); err != nil {
			t.Fatal(err)
		}

		if err := file.Sync(); err != nil {
			t.Fatal(err)
		}

		fsys.Crash()

		if fsys.Exists("ring/new.data") {
			t.Fatal("file survived without SyncDir")
		}
	})

	t.Run("unsynced rename is reverted", func(t *testing.T) {
		fsys := NewMemFS()

		if err := fsys.MkdirAll("ring", 0o755); err != nil {
			t.Fatal(err)
		}

		if err := fsys.SyncDir("."); err != nil {
			t.Fatal(err)
		}

		file, err := fsys.OpenFile("ring/old.data", os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := file.WriteAt([]byte("old"), 0); err != nil {
			t.Fatal(err)
		}

		if err := file.Sync(); err != nil {
			t.Fatal(err)
		}

		if err := fsys.SyncDir("ring"); err != nil {
			t.Fatal(err)
		}

		if err := fsys.Rename("ring/old.data", "ring/new.data"); err != nil {
			t.Fatal(err)
		}

		fsys.Crash()

		if !fsys.Exists("ring/old.data") || fsys.Exists("ring/new.data") {
			t.Fatal("crash did not restore old name")
		}
	})
}

func durableTestFile(t *testing.T, fsys *MemFS, path, initial string) ring.File {
	t.Helper()

	file, err := fsys.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := file.WriteAt([]byte(initial), 0); err != nil {
		t.Fatal(err)
	}

	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}

	if err := fsys.SyncDir("."); err != nil {
		t.Fatal(err)
	}

	return file
}
