//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package ring

import "errors"

// ErrLocked reports that ring directory locking is unavailable.
var ErrLocked = errors.New("ring: directory locking unsupported")

// Lock cannot grant a safe writer lock on this platform.
func Lock(_ string) (func() error, error) {
	return nil, ErrLocked
}
