package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteJSONWritesIndentedJSON(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	if err := AtomicWriteJSON(path, struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}{Name: "test", Count: 2}); err != nil {
		t.Fatalf("AtomicWriteJSON() error = %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	const want = "{\n  \"name\": \"test\",\n  \"count\": 2\n}"
	if string(data) != want {
		t.Fatalf("written JSON = %q, want %q", data, want)
	}
}

func TestAtomicWriteJSONRequiresExistingParentDirectory(t *testing.T) {
	t.Parallel()

	dir := filepath.Join(t.TempDir(), "missing")
	path := filepath.Join(dir, "state.json")

	if err := AtomicWriteJSON(path, map[string]string{"name": "test"}); err == nil {
		t.Fatal("AtomicWriteJSON() error = nil, want missing-parent error")
	}

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("parent directory stat error = %v, want os.ErrNotExist", err)
	}
}

func TestAtomicWriteJSONReplacesTargetAtomically(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if err := AtomicWriteJSON(path, map[string]bool{"enabled": true}); err != nil {
		t.Fatalf("AtomicWriteJSON() error = %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) != "{\n  \"enabled\": true\n}" {
		t.Fatalf("written JSON = %q", data)
	}
}

func TestAtomicWriteJSONCleansTempFileWhenRenameFails(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}

	if err := AtomicWriteJSON(target, map[string]bool{"enabled": true}); err == nil {
		t.Fatal("AtomicWriteJSON() error = nil, want rename error")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	for _, entry := range entries {
		if entry.Name() != "target" {
			t.Fatalf("unexpected leftover temporary entry %q", entry.Name())
		}
	}
}
