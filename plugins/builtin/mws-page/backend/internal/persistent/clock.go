package persistent

import "time"

// Clock returns the current time. Production uses wall-clock UTC; tests inject
// a controlled clock so timestamp and retention decisions are deterministic.
type Clock func() time.Time

func wallClockUTC() time.Time { return time.Now().UTC() }
