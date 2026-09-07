package telemetry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"mndwd/internal/telemetry/journal"
)

const (
	// minUnixMillis and maxUnixMillis bound the supported calendar range for
	// mapped timestamps. Results outside this range are rejected rather than
	// wrapped.
	minUnixMillis = int64(-2208988800000) // 1900-01-01
	maxUnixMillis = int64(4102444800000)  // 2100-01-01
)

// ErrUTCOverflow reports a boot-relative to UTC mapping that overflows or falls
// outside the supported range. Callers must keep the sample time-unknown.
var ErrUTCOverflow = errors.New("telemetry: UTC mapping out of range")

// ClockState is the trust state of one boot's clock segment.
type ClockState string

const (
	// ClockUnanchored means no trustworthy calendar time exists yet.
	ClockUnanchored ClockState = "unanchored"
	// ClockAnchored means retained samples of this segment can be mapped.
	ClockAnchored ClockState = "anchored"
	// ClockSuspect means the clock moved and publication is suppressed.
	ClockSuspect ClockState = "suspect"
)

// ClockView is the durable clock state of one boot segment.
type ClockView struct {
	State              ClockState
	Boot               journal.BootID
	Segment            uint64
	Anchor             *journal.Anchor
	SuspectElapsedMs   *int64
	ConsumedEvidenceID string
}

// Evidence is one clock-evidence observation. AfterSuspect is set only from
// source-proven ordering and never from repeated synchronization flags.
type Evidence struct {
	Synchronized bool
	ID           string
	Source       string
	AfterSuspect bool
}

// EvidenceRequest carries the state the source needs to decide freshness.
type EvidenceRequest struct {
	Boot               journal.BootID
	SuspectElapsedMs   *int64
	ConsumedEvidenceID string
}

// EvidenceSource reads trustworthy synchronization evidence.
type EvidenceSource interface {
	Read(context.Context, EvidenceRequest) (Evidence, error)
}

// CheckedSubInt64 subtracts with overflow detection.
func CheckedSubInt64(a, b int64) (int64, bool) {
	if (b < 0 && a > maxInt64+b) || (b > 0 && a < minInt64+b) {
		return 0, false
	}
	return a - b, true
}

// CheckedAddInt64 adds with overflow detection.
func CheckedAddInt64(a, b int64) (int64, bool) {
	if a > 0 && b > maxInt64-a {
		return 0, false
	}
	if a < 0 && b < minInt64-a {
		return 0, false
	}
	return a + b, true
}

const (
	maxInt64 = int64(^uint64(0) >> 1)
	minInt64 = -maxInt64 - 1
)

// MapUTC maps a boot-relative elapsed instant to UTC milliseconds using an
// anchor from the same boot.
func MapUTC(anchor journal.Anchor, elapsedMs int64) (int64, error) {
	delta, ok := CheckedSubInt64(elapsedMs, anchor.ElapsedMs)
	if !ok {
		return 0, ErrUTCOverflow
	}
	utc, ok := CheckedAddInt64(anchor.UTCMs, delta)
	if !ok || utc < minUnixMillis || utc > maxUnixMillis {
		return 0, ErrUTCOverflow
	}
	return utc, nil
}

// ClockTracker owns clock-state transitions. It proposes zero-sequence records;
// Install exposes a new anchor only after those records are durable.
type ClockTracker struct {
	policy Policy
	view   ClockView
}

// NewClockState restores a tracker from a persisted view.
func NewClockState(saved ClockView) *ClockTracker {
	return NewClockStateWithPolicy(saved, DefaultPolicy())
}

// NewClockStateWithPolicy restores a tracker with explicit policy, for tests.
func NewClockStateWithPolicy(saved ClockView, policy Policy) *ClockTracker {
	if saved.State == "" {
		saved.State = ClockUnanchored
	}
	return &ClockTracker{policy: policy, view: saved}
}

// View returns the current clock state.
func (c *ClockTracker) View() ClockView {
	return c.view
}

// Install publishes a proposed view once its records are durable.
func (c *ClockTracker) Install(view ClockView) {
	c.view = view
}

// Check compares observed wall time with the anchor's prediction on every
// acquisition. It suppresses publication immediately, before any transition can
// be synced.
func (c *ClockTracker) Check(reading Reading) (ClockView, []journal.Record, error) {
	if c.view.Anchor == nil || c.view.State == ClockUnanchored {
		return c.view, nil, nil
	}
	if c.view.Boot != reading.Boot {
		// An anchor from another boot never establishes current trust.
		view := ClockView{State: ClockUnanchored, Boot: reading.Boot, Segment: c.view.Segment + 1}
		return view, transitionRecord(view), nil
	}

	predicted, err := MapUTC(*c.view.Anchor, reading.ElapsedMs)
	if err != nil {
		view := c.suspectView(reading, 0, "")
		if c.view.State == ClockSuspect {
			return view, nil, nil
		}
		return view, transitionRecord(view), nil
	}
	delta, ok := CheckedSubInt64(reading.WallMs, predicted)
	if !ok {
		view := c.suspectView(reading, 0, "")
		if c.view.State == ClockSuspect {
			return view, nil, nil
		}
		return view, transitionRecord(view), nil
	}
	if delta < 0 {
		delta = -delta
	}
	if delta <= c.policy.JumpThreshold.Milliseconds() {
		return c.view, nil, nil
	}
	view := c.suspectView(reading, 0, c.view.ConsumedEvidenceID)
	if c.view.State == ClockSuspect && view.Segment == c.view.Segment {
		return view, nil, nil
	}
	return view, transitionRecord(view), nil
}

func (c *ClockTracker) suspectView(reading Reading, segment uint64, consumed string) ClockView {
	if segment == 0 {
		segment = c.view.Segment
		if c.view.State != ClockSuspect {
			segment++
		}
	}
	elapsed := reading.ElapsedMs
	return ClockView{
		State:              ClockSuspect,
		Boot:               reading.Boot,
		Segment:            segment,
		Anchor:             c.view.Anchor,
		SuspectElapsedMs:   &elapsed,
		ConsumedEvidenceID: consumed,
	}
}

func transitionRecord(view ClockView) []journal.Record {
	state := journal.StateUnanchored
	switch view.State {
	case ClockAnchored:
		state = journal.StateAnchored
	case ClockSuspect:
		state = journal.StateSuspect
	}
	transition := journal.ClockTransition{
		Boot:               view.Boot,
		ClockSegment:       view.Segment,
		State:              state,
		SuspectElapsedMs:   view.SuspectElapsedMs,
		ConsumedEvidenceID: view.ConsumedEvidenceID,
	}
	record, err := journal.PrepareClockTransition(transition)
	if err != nil {
		return nil
	}
	return []journal.Record{record}
}

// Observe proposes an anchor from a bracketed evidence observation. It returns
// the proposed view and the records that must be durable before Install.
func (c *ClockTracker) Observe(before, after Reading, evidence Evidence) (ClockView, []journal.Record, error) {
	if before.Boot != after.Boot {
		return c.view, nil, errors.New("telemetry: clock observation spans boots")
	}
	if !before.Boot.IsZero() && evidence.Synchronized && c.view.Boot != before.Boot && !c.view.Boot.IsZero() {
		return c.view, nil, errors.New("telemetry: clock observation belongs to another boot")
	}
	if after.ElapsedMs < before.ElapsedMs {
		return c.view, nil, errors.New("telemetry: elapsed time decreased during observation")
	}

	elapsedSpan := after.ElapsedMs - before.ElapsedMs
	wallSpan := after.WallMs - before.WallMs
	if elapsedSpan > c.policy.MaxObservationSpan.Milliseconds() {
		return c.view, nil, fmt.Errorf("telemetry: observation bracket %dms exceeds %s", elapsedSpan, c.policy.MaxObservationSpan)
	}
	if wallSpan < 0 {
		wallSpan = -wallSpan
	}
	if wallSpan-elapsedSpan > c.policy.MaxObservationSpan.Milliseconds() {
		return c.view, nil, errors.New("telemetry: wall time moved during observation")
	}

	if !evidence.Synchronized {
		// Losing connectivity or the server does not invalidate an anchor, and
		// unsynchronized evidence cannot create one.
		return c.view, nil, nil
	}
	if c.view.State == ClockSuspect && (!evidence.AfterSuspect || evidence.ID == "" || evidence.ID == c.view.ConsumedEvidenceID) {
		// A sticky synchronized flag never resolves a suspect segment; fresh,
		// separately identified evidence is required.
		return c.view, nil, nil
	}

	elapsedMid := before.ElapsedMs + elapsedSpan/2
	wallMid := before.WallMs + (after.WallMs-before.WallMs)/2
	if wallMid < minUnixMillis || wallMid > maxUnixMillis {
		return c.view, nil, ErrUTCOverflow
	}

	segment := c.view.Segment
	if c.view.State == ClockSuspect || c.view.Anchor == nil || c.view.Boot != before.Boot {
		segment++
	}

	anchor := journal.Anchor{
		Boot:           before.Boot,
		ClockSegment:   segment,
		ElapsedMs:      elapsedMid,
		UTCMs:          wallMid,
		UncertaintyMs:  elapsedSpan / 2,
		EvidenceID:     evidence.ID,
		EvidenceSource: evidence.Source,
	}
	anchorRecord, err := journal.PrepareAnchor(anchor)
	if err != nil {
		return c.view, nil, err
	}
	transition := journal.ClockTransition{
		Boot:               before.Boot,
		ClockSegment:       segment,
		State:              journal.StateAnchored,
		ConsumedEvidenceID: evidence.ID,
	}
	transitionRecord, err := journal.PrepareClockTransition(transition)
	if err != nil {
		return c.view, nil, err
	}

	proposed := ClockView{
		State:              ClockAnchored,
		Boot:               before.Boot,
		Segment:            segment,
		Anchor:             &anchor,
		ConsumedEvidenceID: evidence.ID,
	}
	return proposed, []journal.Record{anchorRecord, transitionRecord}, nil
}

// AlignSlot floors a mapped UTC instant to the tier slot boundary.
func AlignSlot(utcMs int64, slot time.Duration) int64 {
	if slot <= 0 {
		return utcMs
	}
	return utcMs - utcMs%slot.Milliseconds()
}
