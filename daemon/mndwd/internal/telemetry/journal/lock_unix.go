//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package journal

import (
	"context"
	"os"

	"golang.org/x/sys/unix"
)

// OSLocker is the production storage lock. It uses flock on a lock file inside
// JournalDir and never blocks indefinitely: a busy lock is reported to the
// caller so it can degrade instead of stalling acquisition.
type OSLocker struct {
	// flock injects the syscall for tests; defaults to unix.Flock.
	flock func(fd int, operation int) error
}

// fileLockHandle releases a held flock and its file descriptor.
type fileLockHandle struct {
	file *os.File
}

// Acquire takes the requested lock or reports failure.
func (l OSLocker) Acquire(_ context.Context, path string, mode LockMode) (LockHandle, error) {
	if err := checkLockMode(mode); err != nil {
		return nil, err
	}

	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}

	operation := unix.LOCK_EX | unix.LOCK_NB
	if mode == LockShared {
		operation = unix.LOCK_SH | unix.LOCK_NB
	}

	flock := l.flock
	if flock == nil {
		flock = unix.Flock
	}
	if err := flock(int(file.Fd()), operation); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &fileLockHandle{file: file}, nil
}

// Close releases the lock and closes the descriptor.
func (h *fileLockHandle) Close() error {
	if h.file == nil {
		return nil
	}
	file := h.file
	h.file = nil
	_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
	return file.Close()
}
