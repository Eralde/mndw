package journal

import "time"

// StepForSeries returns the fixed fine acquisition step for a journal series.
// Unknown series IDs retain the existing three-minute fallback.
func StepForSeries(uint16) time.Duration {
	return 3 * time.Minute
}
