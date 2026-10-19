//go:build windows

package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadSecureFileAcceptsRegularWindowsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")

	if err := os.WriteFile(path, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := readSecureFile(path, len("secret"))
	if err != nil {
		t.Fatal(err)
	}

	if string(got) != "secret" {
		t.Fatalf("read secret = %q", got)
	}
}
