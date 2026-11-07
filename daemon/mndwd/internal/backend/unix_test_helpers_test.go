package backend

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func shortUnixSocketDir(t *testing.T) string {
	t.Helper()

	directory, err := os.MkdirTemp("/tmp", "mndw-")
	if err != nil {
		t.Fatalf("create short Unix socket directory: %v", err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(directory) })

	return directory
}

func listenUnixForTest(t *testing.T, socketPath string) net.Listener {
	t.Helper()

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
			t.Skipf("sandbox disallows Unix sockets: %v", err)
		}

		t.Fatalf("listen on Unix socket %q: %v", socketPath, err)
	}

	return listener
}

func shortUnixSocketPath(t *testing.T, name string) string {
	t.Helper()

	return filepath.Join(shortUnixSocketDir(t), name)
}
