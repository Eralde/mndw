//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package ring

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// ErrLocked reports that another process owns the ring directory lock.
var ErrLocked = errors.New("ring: directory is locked")

// Lock takes a non-blocking exclusive flock on dir/lock.
func Lock(dir string) (func() error, error) {
	path := filepath.Join(dir, "lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, wrapIO("open lock", err)
	}

	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()

		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, fmt.Errorf("%w: %s", ErrLocked, dir)
		}

		return nil, wrapIO("flock", err)
	}

	var released bool
	release := func() error {
		if released {
			return nil
		}

		released = true
		unlockErr := unix.Flock(int(file.Fd()), unix.LOCK_UN)
		closeErr := file.Close()

		if unlockErr != nil {
			return wrapIO("unlock", unlockErr)
		}

		if closeErr != nil {
			return wrapIO("close lock", closeErr)
		}

		return nil
	}

	return release, nil
}
