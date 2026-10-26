//go:build !linux

package system

import "errors"

// NewOSClock reports that telemetry boot-clock support requires Linux.
func NewOSClock() (Clock, error) {
	return nil, errors.New("telemetry system: operating-system boot clock is unsupported")
}
