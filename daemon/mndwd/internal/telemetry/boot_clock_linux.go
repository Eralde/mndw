//go:build linux

package telemetry

import (
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"mndwd/internal/telemetry/journal"
)

// bootIDPath is the Linux boot identifier exposed by the kernel.
const bootIDPath = "/proc/sys/kernel/random/boot_id"

// NewBootClock returns the platform boot clock. Boot identity is read once and
// validated before it is cached; a failure yields a clock whose every Read
// reports the construction error instead of falling back to wall time.
func NewBootClock() BootClock {
	boot, err := readBootID(bootIDPath)
	if err != nil {
		return newUnsupportedBootClock(err)
	}
	return newBootClock(boot, readElapsedMs, func() int64 { return time.Now().UnixMilli() })
}

func readBootID(path string) (journal.BootID, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return journal.BootID{}, fmt.Errorf("telemetry: read boot id: %w", err)
	}
	return ParseBootID(strings.TrimSpace(string(raw)))
}

func readElapsedMs() (int64, error) {
	var elapsed unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &elapsed); err != nil {
		return 0, fmt.Errorf("telemetry: read boottime clock: %w", err)
	}
	return elapsed.Nano() / int64(time.Millisecond), nil
}
