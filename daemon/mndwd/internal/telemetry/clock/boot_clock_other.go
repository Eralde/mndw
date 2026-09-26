//go:build !linux

package clock

// NewBootClock reports that boot identity and boot-relative elapsed time are
// unavailable. Callers must keep acquisition bounded in memory and must not
// substitute wall time for boot-relative time.
func NewBootClock() BootClock {
	return newUnsupportedBootClock(ErrBootClockUnsupported)
}
