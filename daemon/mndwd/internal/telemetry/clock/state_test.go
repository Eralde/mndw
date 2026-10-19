package clock

import (
	"context"
	"errors"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

var testClockPolicy = Policy{JumpThreshold: 5 * time.Second, MaxObservationSpan: time.Second}

func newTestTracker(saved View) *Tracker {
	return NewTracker(saved, testClockPolicy)
}

func TestStableWrongClockDoesNotClearSuspect(t *testing.T) {
	at := int64(1800000000000)
	tracker := newTestTracker(View{State: "suspect", Boot: journal.BootID{1}, Segment: 2})
	before := Reading{Boot: journal.BootID{1}, ElapsedMs: 60000, WallMs: at + 3600000}
	after := before
	after.ElapsedMs += 10
	after.WallMs += 10
	view, _, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "old", Source: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != "suspect" {
		t.Fatal("sticky true re-anchored wrong clock")
	}
}

func TestSuspectClearsOnlyWithFreshIdentifiedEvidence(t *testing.T) {
	tracker := newTestTracker(View{
		State:              Suspect,
		Boot:               journal.BootID{1},
		Segment:            2,
		ConsumedEvidenceID: "old",
	})
	before := Reading{Boot: journal.BootID{1}, ElapsedMs: 60000, WallMs: 1800000000000}
	after := Reading{Boot: journal.BootID{1}, ElapsedMs: 60010, WallMs: 1800000000010}

	view, records, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "new", Source: "fixture", AfterSuspect: true})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != Anchored || view.Anchor == nil {
		t.Fatalf("fresh evidence did not anchor: %+v", view)
	}

	if len(records) != 2 || records[0].Kind != journal.KindAnchor || records[1].Kind != journal.KindClockTransition {
		t.Fatalf("records=%+v", records)
	}

	for _, record := range records {
		if record.Seq != 0 {
			t.Fatalf("record carries assigned sequence %d", record.Seq)
		}
	}

	if view.Anchor.UTCMs != 1800000000005 {
		t.Fatalf("anchor utc=%d", view.Anchor.UTCMs)
	}

	if view.Anchor.ElapsedMs != 60005 {
		t.Fatalf("anchor elapsed=%d", view.Anchor.ElapsedMs)
	}
}

func TestFirstAnchorUsesInitialSegment(t *testing.T) {
	boot := journal.BootID{1}
	tracker := newTestTracker(View{State: Unanchored, Boot: boot, Segment: 0})
	before := Reading{Boot: boot, ElapsedMs: 1000, WallMs: 1800000000000}
	after := Reading{Boot: boot, ElapsedMs: 1010, WallMs: 1800000000010}

	view, records, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "first", Source: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != Anchored || view.Segment != 0 || view.Anchor == nil || view.Anchor.ClockSegment != 0 {
		t.Fatalf("first anchor did not remain in initial segment: %+v", view)
	}

	if len(records) != 2 || records[0].Kind != journal.KindAnchor || records[1].Kind != journal.KindClockTransition {
		t.Fatalf("records=%+v", records)
	}

	anchor, err := journal.DecodeAnchor(records[0])
	if err != nil || anchor.ClockSegment != 0 {
		t.Fatalf("anchor=%+v error=%v", anchor, err)
	}
}

func TestRepeatedSameSegmentEvidenceDoesNotReplaceAnchor(t *testing.T) {
	boot := journal.BootID{2}
	anchor := journal.Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 0, UTCMs: 1800000000000, UncertaintyMs: 100}
	tracker := newTestTracker(View{State: Anchored, Boot: boot, Segment: 0, Anchor: &anchor})
	before := Reading{Boot: boot, ElapsedMs: 10000, WallMs: anchor.UTCMs + 14000}
	after := Reading{Boot: boot, ElapsedMs: 10010, WallMs: anchor.UTCMs + 14010}

	view, records, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "repeat", Source: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	if len(records) != 0 {
		t.Fatalf("same-segment observation emitted %d records", len(records))
	}

	if view.Anchor == nil || *view.Anchor != anchor {
		t.Fatalf("same-segment observation replaced canonical anchor: %+v", view.Anchor)
	}
}

func TestObserveRejectsOverlongBracket(t *testing.T) {
	tracker := newTestTracker(View{State: Unanchored, Boot: journal.BootID{1}})
	before := Reading{Boot: journal.BootID{1}, ElapsedMs: 1000, WallMs: 1800000000000}
	after := Reading{Boot: journal.BootID{1}, ElapsedMs: 1000 + 1500, WallMs: 1800000001500}

	if _, _, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "ev", Source: "fixture"}); err == nil {
		t.Fatal("accepted a 1.5s observation bracket")
	}
}

func TestObserveRejectsBootMismatch(t *testing.T) {
	tracker := newTestTracker(View{State: Unanchored, Boot: journal.BootID{1}})
	before := Reading{Boot: journal.BootID{1}, ElapsedMs: 1000, WallMs: 1800000000000}
	after := Reading{Boot: journal.BootID{2}, ElapsedMs: 1100, WallMs: 1800000000100}

	if _, _, err := tracker.Observe(before, after, Evidence{Synchronized: true, ID: "ev", Source: "fixture"}); err == nil {
		t.Fatal("accepted an observation spanning boots")
	}
}

func TestFirstAnchorMapsEarlierSamplesOfSameBoot(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 4 * 60 * 60 * 1000, UTCMs: 1800000000000}
	mapped, err := MapUTC(anchor, 0)
	if err != nil {
		t.Fatal(err)
	}

	if mapped != 1800000000000-4*60*60*1000 {
		t.Fatalf("mapped=%d", mapped)
	}
}

func TestMapUTCRejectsOverflow(t *testing.T) {
	if _, err := MapUTC(journal.Anchor{ElapsedMs: 0, UTCMs: maxUnixMillis}, 1000); !errors.Is(err, ErrUTCOverflow) {
		t.Fatalf("upper range accepted: %v", err)
	}

	if _, err := MapUTC(journal.Anchor{ElapsedMs: 0, UTCMs: minUnixMillis}, -1000); !errors.Is(err, ErrUTCOverflow) {
		t.Fatalf("lower range accepted: %v", err)
	}

	if _, err := MapUTC(journal.Anchor{ElapsedMs: minInt64, UTCMs: 0}, maxInt64); !errors.Is(err, ErrUTCOverflow) {
		t.Fatalf("subtraction overflow accepted: %v", err)
	}

	if _, ok := checkedSubInt64(minInt64, 1); ok {
		t.Fatal("checked subtraction missed underflow")
	}

	if _, ok := checkedAddInt64(maxInt64, 1); ok {
		t.Fatal("checked addition missed overflow")
	}
}

func TestCheckDetectsJumpAndToleratesDrift(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 1000, UTCMs: 1800000000000}
	tracker := newTestTracker(View{State: Anchored, Boot: journal.BootID{1}, Segment: 1, Anchor: &anchor})

	drifted, _, err := tracker.Check(Reading{Boot: journal.BootID{1}, ElapsedMs: 2000, WallMs: 1800000001000 + 4000})
	if err != nil {
		t.Fatal(err)
	}

	if drifted.State != Anchored {
		t.Fatalf("4s drift entered suspect: %+v", drifted)
	}

	jumped, _, err := tracker.Check(Reading{Boot: journal.BootID{1}, ElapsedMs: 3000, WallMs: 1800000002000 + 6000})
	if err != nil {
		t.Fatal(err)
	}

	if jumped.State != Suspect || jumped.SuspectElapsedMs == nil || *jumped.SuspectElapsedMs != 3000 {
		t.Fatalf("6s jump not detected: %+v", jumped)
	}
}

func TestSlowDriftBelowAndAboveThreshold(t *testing.T) {
	boot := journal.BootID{3}
	base := int64(1800000000000)
	anchor := journal.Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 0, UTCMs: base}
	tracker := newTestTracker(View{State: Anchored, Boot: boot, Segment: 0, Anchor: &anchor})

	fiveDays := int64((5 * 24 * time.Hour).Milliseconds())
	below, _, err := tracker.Check(Reading{Boot: boot, ElapsedMs: fiveDays, WallMs: base + fiveDays + fiveDays/100000})
	if err != nil {
		t.Fatal(err)
	}

	if below.State != Anchored {
		t.Fatalf("10 ppm drift below threshold entered suspect: %+v", below)
	}

	sixDays := int64((6 * 24 * time.Hour).Milliseconds())
	above, records, err := tracker.Check(Reading{Boot: boot, ElapsedMs: sixDays, WallMs: base + sixDays + sixDays/100000})
	if err != nil {
		t.Fatal(err)
	}

	if above.State != Suspect || above.Segment != 1 || len(records) != 1 {
		t.Fatalf("10 ppm drift above threshold did not enter suspect once: view=%+v records=%d", above, len(records))
	}

	tracker.Install(above)

	sevenDays := int64((7 * 24 * time.Hour).Milliseconds())
	repeated, records, err := tracker.Check(Reading{Boot: boot, ElapsedMs: sevenDays, WallMs: base + sevenDays + sevenDays/100000})
	if err != nil {
		t.Fatal(err)
	}

	if repeated.State != Suspect || repeated.Segment != above.Segment || len(records) != 0 {
		t.Fatalf("suspect transition repeated: view=%+v records=%d", repeated, len(records))
	}

	before := Reading{Boot: boot, ElapsedMs: sevenDays, WallMs: base + sevenDays + sevenDays/100000}
	after := before
	after.ElapsedMs += 10
	after.WallMs += 10
	reanchored, records, err := tracker.Observe(before, after,
		Evidence{Synchronized: true, ID: "fresh", Source: "fixture", AfterSuspect: true})
	if err != nil {
		t.Fatal(err)
	}

	if reanchored.State != Anchored || reanchored.Segment != 2 || len(records) != 2 {
		t.Fatalf("fresh evidence did not establish next segment: view=%+v records=%d", reanchored, len(records))
	}
}

func TestCheckRejectsAnchorFromAnotherBoot(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 1000, UTCMs: 1800000000000}
	tracker := newTestTracker(View{State: Anchored, Boot: journal.BootID{1}, Segment: 1, Anchor: &anchor})
	view, _, err := tracker.Check(Reading{Boot: journal.BootID{2}, ElapsedMs: 1000, WallMs: 1800000000000})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != Unanchored || view.Anchor != nil {
		t.Fatalf("another boot's anchor still trusted: %+v", view)
	}
}

func TestWANLossKeepsEstablishedAnchor(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 1000, UTCMs: 1800000000000}
	tracker := newTestTracker(View{State: Anchored, Boot: journal.BootID{1}, Segment: 1, Anchor: &anchor})
	before := Reading{Boot: journal.BootID{1}, ElapsedMs: 2000, WallMs: 1800000001000}
	after := Reading{Boot: journal.BootID{1}, ElapsedMs: 2010, WallMs: 1800000001010}

	view, records, err := tracker.Observe(before, after, Evidence{Synchronized: false})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != Anchored {
		t.Fatalf("connectivity loss invalidated the anchor: %+v", view)
	}

	if len(records) != 0 {
		t.Fatalf("unsynchronized evidence proposed records: %+v", records)
	}
}

func TestRestartCheckDetectsClockStepWhileStopped(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 1000, UTCMs: 1800000000000}
	tracker := newTestTracker(View{State: Anchored, Boot: journal.BootID{1}, Segment: 1, Anchor: &anchor})
	view, _, err := tracker.Check(Reading{Boot: journal.BootID{1}, ElapsedMs: 1000, WallMs: 1800003600000})
	if err != nil {
		t.Fatal(err)
	}

	if view.State != Suspect {
		t.Fatalf("startup step not detected: %+v", view)
	}
}

func TestReadEvidenceOrderingAndFailure(t *testing.T) {
	boot := journal.BootID{1}
	clock := &scriptedClock{readings: []Reading{
		{Boot: boot, ElapsedMs: 1000, WallMs: 1800000000000},
		{Boot: boot, ElapsedMs: 1010, WallMs: 1800000000010},
	}}
	source := &staticEvidenceSource{evidence: Evidence{Synchronized: true, ID: "ev-1", Source: "fixture"}}

	before, after, evidence, err := ReadEvidence(context.Background(), clock, source, EvidenceRequest{Boot: boot})
	if err != nil {
		t.Fatal(err)
	}

	if before.ElapsedMs != 1000 || after.ElapsedMs != 1010 {
		t.Fatalf("bracket=%d..%d", before.ElapsedMs, after.ElapsedMs)
	}

	if !evidence.Synchronized {
		t.Fatal("evidence lost")
	}

	if source.calls != 1 {
		t.Fatalf("source calls=%d", source.calls)
	}

	failing := &staticEvidenceSource{err: errors.New("query failed")}
	clock.index = 0

	if _, _, _, err := ReadEvidence(context.Background(), clock, failing, EvidenceRequest{Boot: boot}); err == nil {
		t.Fatal("source error accepted")
	}
}

func TestReadEvidenceDiscardsInconsistentBracket(t *testing.T) {
	boot := journal.BootID{1}
	clock := &scriptedClock{readings: []Reading{
		{Boot: boot, ElapsedMs: 1000, WallMs: 1800000000000},
		{Boot: journal.BootID{2}, ElapsedMs: 1010, WallMs: 1800000000010},
	}}
	source := &staticEvidenceSource{evidence: Evidence{Synchronized: true, ID: "ev-1", Source: "fixture"}}

	if _, _, _, err := ReadEvidence(context.Background(), clock, source, EvidenceRequest{Boot: boot}); err == nil {
		t.Fatal("boot change during observation accepted")
	}
}

func TestAlignSlotFloorsToBoundary(t *testing.T) {
	if got := AlignSlot(1800000090000, 15*time.Minute); got != 1800000000000 {
		t.Fatalf("align=%d", got)
	}

	if got := AlignSlot(1800000179999, 3*time.Minute); got != 1800000000000 {
		t.Fatalf("align=%d", got)
	}
}
