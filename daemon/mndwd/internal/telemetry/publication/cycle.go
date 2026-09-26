package publication

import "mndwd/internal/telemetry/clock"

// Cycle is one publication opportunity from the acquisition pipeline.
type Cycle struct {
	CutoffElapsedMs int64
	DurableThrough  uint64
	Clock           clock.View
}
