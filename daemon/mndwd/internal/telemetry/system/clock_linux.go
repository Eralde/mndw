//go:build linux

package system

import (
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"mndwd/internal/telemetry/timekeeper"
)

const linuxBootIDPath = "/proc/sys/kernel/random/boot_id"

type osClock struct {
	bootID [16]byte
}

// NewOSClock creates a clock backed by Linux boot identity and CLOCK_BOOTTIME.
func NewOSClock() (Clock, error) {
	raw, err := os.ReadFile(linuxBootIDPath)
	if err != nil {
		return nil, fmt.Errorf("telemetry system: read boot id: %w", err)
	}

	bootID, err := parseBootID(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, err
	}

	return &osClock{bootID: bootID}, nil
}

func bootMillis(ts unix.Timespec) int64 {
	return int64(ts.Sec)*1000 + int64(ts.Nsec)/1_000_000
}

func (c *osClock) Read() (timekeeper.Reading, error) {
	var now unix.Timespec

	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &now); err != nil {
		return timekeeper.Reading{}, fmt.Errorf("telemetry system: read CLOCK_BOOTTIME: %w", err)
	}

	bootMs := bootMillis(now)

	return timekeeper.Reading{BootMs: bootMs, WallMs: time.Now().UnixMilli()}, nil
}

func (c *osClock) BootID() [16]byte {
	return c.bootID
}
