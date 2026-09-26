package clock

import (
	"errors"
	"sync"

	"mndwd/internal/telemetry/journal"
)

// ErrBootClockUnsupported reports that this platform cannot supply boot
// identity or boot-relative elapsed time. Callers must degrade to bounded
// in-memory retention instead of substituting wall time.
var ErrBootClockUnsupported = errors.New("telemetry: boot clock unsupported on this platform")

// Reading is one observation of boot identity, boot-relative elapsed time, and
// untrusted wall time.
type Reading struct {
	Boot      journal.BootID
	ElapsedMs int64
	WallMs    int64
}

// BootClock supplies boot-relative coordinates. Implementations must never
// derive ElapsedMs from wall time.
type BootClock interface {
	Read() (Reading, error)
}

// bootClock is the injectable implementation shared by every platform.
type bootClock struct {
	boot    journal.BootID
	elapsed func() (int64, error)
	now     func() int64
	err     error

	mu          sync.Mutex
	lastElapsed int64
}

func newBootClock(boot journal.BootID, elapsed func() (int64, error), now func() int64) BootClock {
	return &bootClock{boot: boot, elapsed: elapsed, now: now}
}

func newUnsupportedBootClock(err error) BootClock {
	return &bootClock{err: err, elapsed: func() (int64, error) { return 0, err }, now: func() int64 { return 0 }}
}

func (c *bootClock) Read() (Reading, error) {
	if c.err != nil {
		return Reading{}, c.err
	}

	elapsed, err := c.elapsed()
	if err != nil {
		return Reading{}, err
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	if elapsed < c.lastElapsed {
		// CLOCK_BOOTTIME never decreases; clamp defensively so a bad read
		// cannot make time appear to move backwards.
		elapsed = c.lastElapsed
	}

	c.lastElapsed = elapsed

	return Reading{Boot: c.boot, ElapsedMs: elapsed, WallMs: c.now()}, nil
}

// ParseBootID validates the canonical hyphenated UUID spelling of a Linux boot
// identifier and returns its 16 bytes. It never accepts a truncated,
// overlong, uppercase, or non-hexadecimal spelling.
func ParseBootID(raw string) (journal.BootID, error) {
	var id journal.BootID

	if len(raw) != 36 {
		return journal.BootID{}, errors.New("telemetry: boot id must be a 36-character uuid")
	}

	for _, i := range [...]int{8, 13, 18, 23} {
		if raw[i] != '-' {
			return journal.BootID{}, errors.New("telemetry: boot id must be hyphenated 8-4-4-4-12")
		}
	}

	digit := func(b byte) (byte, bool) {
		switch {
		case b >= '0' && b <= '9':
			return b - '0', true
		case b >= 'a' && b <= 'f':
			return b - 'a' + 10, true
		default:
			return 0, false
		}
	}

	byteIndex := 0

	for i := 0; i < len(raw); i++ {
		if raw[i] == '-' {
			continue
		}

		high, ok := digit(raw[i])

		if !ok {
			return journal.BootID{}, errors.New("telemetry: boot id must use lowercase hexadecimal digits")
		}

		i++
		low, ok := digit(raw[i])

		if !ok {
			return journal.BootID{}, errors.New("telemetry: boot id must use lowercase hexadecimal digits")
		}

		id[byteIndex] = high<<4 | low
		byteIndex++
	}

	if byteIndex != len(id) {
		return journal.BootID{}, errors.New("telemetry: boot id must encode 16 bytes")
	}

	if id.IsZero() {
		return journal.BootID{}, errors.New("telemetry: boot id must not be all zeroes")
	}

	return id, nil
}
