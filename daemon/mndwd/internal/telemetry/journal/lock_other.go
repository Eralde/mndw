//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package journal

import (
	"context"
	"errors"
)

// ErrLockUnsupported reports that this platform cannot provide advisory file
// locking, so storage cannot be owned.
var ErrLockUnsupported = errors.New("journal: storage locking unsupported on this platform")

// OSLocker reports unsupported on platforms without flock.
type OSLocker struct{}

// Acquire never grants ownership on this platform.
func (OSLocker) Acquire(_ context.Context, _ string, _ LockMode) (LockHandle, error) {
	return nil, ErrLockUnsupported
}
