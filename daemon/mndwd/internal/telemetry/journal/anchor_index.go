package journal

import (
	"errors"
	"math"
	"time"
)

// ErrUTCOutOfRange reports an elapsed-to-UTC mapping that overflows or falls
// outside the supported calendar range.
var ErrUTCOutOfRange = errors.New("journal: UTC mapping out of range")

const (
	minUnixMillis = int64(-2208988800000) // 1900-01-01
	maxUnixMillis = int64(4102444800000)  // 2100-01-01
)

// SegmentKey identifies one clock segment in one device boot.
type SegmentKey struct {
	Boot         BootID
	ClockSegment uint64
}

// AnchorIndex selects one canonical anchor for each boot and clock segment.
// It also keeps the minimal boot and transition history needed to recognize
// segment-zero samples from journals written before the initial-segment fix.
type AnchorIndex struct {
	anchors      map[SegmentKey]Anchor
	firstAnchors map[BootID]Anchor
	bootStarts   map[BootID]BootStart
	transitions  map[BootID][]ClockTransition
}

// BuildAnchorIndex builds a canonical index independent of record scan order.
// When duplicate anchors exist, the lowest journal sequence wins.
func BuildAnchorIndex(records []Record) AnchorIndex {
	index := AnchorIndex{
		anchors:      make(map[SegmentKey]Anchor),
		firstAnchors: make(map[BootID]Anchor),
		bootStarts:   make(map[BootID]BootStart),
		transitions:  make(map[BootID][]ClockTransition),
	}

	for _, record := range records {
		switch record.Kind {
		case KindAnchor:
			anchor, err := DecodeAnchor(record)
			if err != nil {
				continue
			}

			key := SegmentKey{Boot: anchor.Boot, ClockSegment: anchor.ClockSegment}

			if existing, ok := index.anchors[key]; !ok || anchor.Seq < existing.Seq {
				index.anchors[key] = anchor
			}

			if existing, ok := index.firstAnchors[anchor.Boot]; !ok || anchor.Seq < existing.Seq {
				index.firstAnchors[anchor.Boot] = anchor
			}
		case KindBootStart:
			bootStart, err := DecodeBootStart(record)
			if err != nil {
				continue
			}

			if existing, ok := index.bootStarts[bootStart.Boot]; !ok || bootStart.Seq < existing.Seq {
				index.bootStarts[bootStart.Boot] = bootStart
			}
		case KindClockTransition:
			transition, err := DecodeClockTransition(record)
			if err != nil {
				continue
			}

			index.transitions[transition.Boot] = append(index.transitions[transition.Boot], transition)
		}
	}

	return index
}

// AnchorFor returns the canonical anchor for a sample. The only fallback is
// the legacy initial segment-zero pattern emitted before anchors retained the
// tracker's initial segment number.
func (index AnchorIndex) AnchorFor(sample Sample) (Anchor, bool) {
	if anchor, ok := index.anchors[SegmentKey{Boot: sample.Boot, ClockSegment: sample.ClockSegment}]; ok {
		return anchor, true
	}

	if sample.ClockSegment != 0 {
		return Anchor{}, false
	}

	first, ok := index.firstAnchors[sample.Boot]

	if !ok || first.ClockSegment != 1 {
		return Anchor{}, false
	}

	bootStart, ok := index.bootStarts[sample.Boot]

	if !ok || sample.Seq <= bootStart.Seq || sample.Seq >= first.Seq {
		return Anchor{}, false
	}

	for _, transition := range index.transitions[sample.Boot] {
		if transition.Seq <= bootStart.Seq || transition.Seq >= first.Seq {
			continue
		}

		if transition.State != StateUnanchored || transition.ClockSegment != 0 {
			return Anchor{}, false
		}
	}

	return first, true
}

// HasAnchor reports whether a segment has its canonical exact-key anchor.
func (index AnchorIndex) HasAnchor(key SegmentKey) bool {
	_, ok := index.anchors[key]

	return ok
}

// CanMapLegacySegmentZero reports whether the journal has the narrowly
// supported pre-fix initial-segment pattern for this boot. Individual samples
// still pass AnchorFor's sequence and transition checks.
func (index AnchorIndex) CanMapLegacySegmentZero(boot BootID) bool {
	first, ok := index.firstAnchors[boot]

	if !ok || first.ClockSegment != 1 {
		return false
	}

	bootStart, ok := index.bootStarts[boot]

	if !ok || first.Seq <= bootStart.Seq {
		return false
	}

	for _, transition := range index.transitions[boot] {
		if transition.Seq <= bootStart.Seq || transition.Seq >= first.Seq {
			continue
		}

		if transition.State != StateUnanchored || transition.ClockSegment != 0 {
			return false
		}
	}

	return true
}

// MapUTC maps a boot-relative elapsed instant to UTC milliseconds using one
// canonical anchor. Results outside 1900-01-01 through 2100-01-01 are rejected.
func MapUTC(anchor Anchor, elapsedMs int64) (int64, error) {
	delta, ok := checkedSubInt64(elapsedMs, anchor.ElapsedMs)

	if !ok {
		return 0, ErrUTCOutOfRange
	}

	utc, ok := checkedAddInt64(anchor.UTCMs, delta)

	if !ok || utc < minUnixMillis || utc > maxUnixMillis {
		return 0, ErrUTCOutOfRange
	}

	return utc, nil
}

// SampleExpired applies the journal's strict retention cutoff to mapped UTC,
// or to elapsed time within the sample's own boot when UTC is unknown.
func SampleExpired(sample Sample, mappedUTC *int64, input RetentionInput, keep time.Duration) bool {
	if keep <= 0 {
		return false
	}

	if mappedUTC != nil {
		if input.TrustedNowMs == nil {
			return false
		}

		return elapsedGreaterThan(*input.TrustedNowMs, *mappedUTC, keep.Milliseconds())
	}

	latest, ok := input.LatestElapsed[sample.Boot]

	if !ok {
		return false
	}

	return elapsedGreaterThan(latest, sample.ElapsedMs, keep.Milliseconds())
}

func elapsedGreaterThan(later, earlier, threshold int64) bool {
	if later <= earlier {
		return false
	}

	return uint64(later)-uint64(earlier) > uint64(threshold)
}

func checkedSubInt64(a, b int64) (int64, bool) {
	if (b < 0 && a > math.MaxInt64+b) || (b > 0 && a < math.MinInt64+b) {
		return 0, false
	}

	return a - b, true
}

func checkedAddInt64(a, b int64) (int64, bool) {
	if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
		return 0, false
	}

	return a + b, true
}
