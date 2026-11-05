//go:build !windows

package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestStartDetachedTransfersFlockAcrossProcess(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "helper.sh")
	started := filepath.Join(root, "started")
	release := filepath.Join(root, "release")
	content := "#!/bin/sh\nprintf started > \"$1\"\nwhile [ ! -e \"$2\" ]; do sleep 0.01; done\n"

	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}

	lockPath := filepath.Join(root, "lock")
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}

	if err := unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}

	if err := startDetached(script, []string{started, release}, lockFile); err != nil {
		t.Fatal(err)
	}

	if err := lockFile.Close(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)

	for {
		if _, err := os.Stat(started); err == nil {
			break
		}

		if time.Now().After(deadline) {
			t.Fatal("detached helper did not start")
		}

		time.Sleep(10 * time.Millisecond)
	}

	probe, err := os.OpenFile(lockPath, os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}

	if err := unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
		t.Fatal("lock unexpectedly became free before child exit")
	}

	_ = probe.Close()

	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	deadline = time.Now().Add(2 * time.Second)

	for {
		probe, err = os.OpenFile(lockPath, os.O_RDWR, 0o644)
		if err != nil {
			t.Fatal(err)
		}

		flockErr := unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		_ = probe.Close()

		if flockErr == nil {
			break
		}

		if time.Now().After(deadline) {
			t.Fatal("lock remained held after detached helper exit")
		}

		time.Sleep(10 * time.Millisecond)
	}
}
