package publication

import (
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

// UnknownBoundaryMode selects how a discontinuity is expressed in RRD.
type UnknownBoundaryMode string

const (
	// UnknownBoundaryExplicit writes an explicit unknown update at the slot
	// after a gap so RRD cannot carry a previous boot's gauge across it. This
	// is the preferred encoding and the one the plan expects the target to
	// support.
	UnknownBoundaryExplicit UnknownBoundaryMode = "explicit-unknown"
	// UnknownBoundarySkip leaves the gap empty, accepting one ambiguous
	// calendar bucket while raw records remain retained.
	UnknownBoundarySkip UnknownBoundaryMode = "skip"
)

// CurrentUnknownBoundaryMode is the daemon's chosen encoding. It is target
// policy, not device-verified behavior: the installed RRDtool must accept
// the explicit unknown update without bridging the gap.
const CurrentUnknownBoundaryMode = UnknownBoundaryExplicit

// BoundaryKind names the discontinuity that requires an unknown boundary.
type BoundaryKind string

const (
	BoundaryReboot     BoundaryKind = "reboot"
	BoundaryClockBreak BoundaryKind = "clock-segment"
	BoundaryGap        BoundaryKind = "collection-gap"
	BoundaryHeartbeat  BoundaryKind = "heartbeat-expiry"
)

// UnknownBoundary describes one discontinuity on the calendar timeline.
type UnknownBoundary struct {
	Series     uint16
	Kind       BoundaryKind
	SlotMs     int64
	LastMapped *int64
}

// UnknownBoundaryPoints renders the updates that establish an unknown boundary.
// Under the explicit mode it emits one unknown update at the slot after the
// gap; under the skip mode it emits nothing and reports the sacrificed bucket.
func UnknownBoundaryPoints(boundary UnknownBoundary, mode UnknownBoundaryMode) []rrd.UpdatePoint {
	if mode == UnknownBoundarySkip {
		return nil
	}

	values := make([]rrd.Value, 0, seriesValueCount(boundary.Series))

	for i := 0; i < seriesValueCount(boundary.Series); i++ {
		values = append(values, rrd.Unknown)
	}

	return []rrd.UpdatePoint{{Timestamp: time.UnixMilli(boundary.SlotMs).UTC(), Values: values}}
}

// DetectBoundaries finds discontinuities in one series' ordered mapped slots:
// reboot and clock-segment breaks come from record metadata, gaps and heartbeat
// expiry from slot spacing.
func DetectBoundaries(samples []journal.Sample, anchorByBoot func(journal.BootID) (journal.Anchor, bool), heartbeat time.Duration) ([]UnknownBoundary, error) {
	boundaries := make([]UnknownBoundary, 0)
	var previousBoot journal.BootID
	var previousSegment uint64
	var previousSlot int64
	have := false

	for _, sample := range samples {
		anchor, ok := anchorByBoot(sample.Boot)

		if !ok {
			continue
		}

		mapped, err := clock.MapUTC(anchor, sample.ElapsedMs)
		if err != nil {
			continue
		}

		slot := clock.AlignSlot(mapped, journal.StepForSeries(sample.Series))

		if have {
			switch {
			case sample.Boot != previousBoot:
				boundaries = append(boundaries, UnknownBoundary{Series: sample.Series, Kind: BoundaryReboot, SlotMs: slot})
			case sample.ClockSegment != previousSegment:
				boundaries = append(boundaries, UnknownBoundary{Series: sample.Series, Kind: BoundaryClockBreak, SlotMs: slot})
			case heartbeat > 0 && slot-previousSlot > heartbeat.Milliseconds():
				previous := previousSlot
				boundaries = append(boundaries, UnknownBoundary{
					Series:     sample.Series,
					Kind:       BoundaryHeartbeat,
					SlotMs:     previous + journal.StepForSeries(sample.Series).Milliseconds(),
					LastMapped: &previous,
				})
			}
		}

		previousBoot = sample.Boot
		previousSegment = sample.ClockSegment
		previousSlot = slot
		have = true
	}

	return boundaries, nil
}

// seriesValueCount returns the number of data sources for a series: load has
// cpu and ram, temperature has one value in milli-Celsius.
func seriesValueCount(series uint16) int {
	if series == 2 {
		return 1
	}

	return 2
}
