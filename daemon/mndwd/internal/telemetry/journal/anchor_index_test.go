package journal

import (
	"math"
	"testing"
	"time"
)

func TestAnchorIndexUsesLowestSequencePerBootAndSegment(t *testing.T) {
	bootA := BootID{1}
	bootB := BootID{2}
	index := BuildAnchorIndex([]Record{
		anchorRecord(t, 40, bootA, 3, 1000, 1800000002000),
		anchorRecord(t, 20, bootA, 3, 500, 1800000001000),
		anchorRecord(t, 10, bootA, 4, 0, 1800000003000),
		anchorRecord(t, 15, bootB, 3, 0, 1800000004000),
	})

	for _, test := range []struct {
		name    string
		sample  Sample
		wantSeq uint64
	}{
		{name: "same boot and segment", sample: Sample{Boot: bootA, ClockSegment: 3}, wantSeq: 20},
		{name: "different segment", sample: Sample{Boot: bootA, ClockSegment: 4}, wantSeq: 10},
		{name: "different boot", sample: Sample{Boot: bootB, ClockSegment: 3}, wantSeq: 15},
	} {
		t.Run(test.name, func(t *testing.T) {
			anchor, ok := index.AnchorFor(test.sample)

			if !ok || anchor.Seq != test.wantSeq {
				t.Fatalf("anchor=(%+v, %t), want sequence %d", anchor, ok, test.wantSeq)
			}
		})
	}
}

func TestAnchorIndexAllowsOnlyLegacyInitialSegmentZeroFallback(t *testing.T) {
	boot := BootID{3}
	bootStart := bootStartRecord(t, 10, boot, 1000)
	firstAnchor := anchorRecord(t, 30, boot, 1, 2000, 1800000000000)
	index := BuildAnchorIndex([]Record{firstAnchor, bootStart})

	anchor, ok := index.AnchorFor(Sample{Seq: 20, Boot: boot, ClockSegment: 0, ElapsedMs: 1500})

	if !ok || anchor.Seq != firstAnchor.Seq {
		t.Fatalf("legacy segment-zero fallback=(%+v, %t), want first segment-one anchor", anchor, ok)
	}

	for _, test := range []struct {
		name    string
		sample  Sample
		records []Record
	}{
		{name: "sample before boot start", sample: Sample{Seq: 9, Boot: boot, ClockSegment: 0}},
		{name: "sample after first anchor", sample: Sample{Seq: 31, Boot: boot, ClockSegment: 0}},
		{name: "missing boot start", sample: Sample{Seq: 20, Boot: boot, ClockSegment: 0}, records: []Record{firstAnchor}},
		{
			name:    "suspect before anchor",
			sample:  Sample{Seq: 20, Boot: boot, ClockSegment: 0},
			records: []Record{bootStart, transitionRecordForTest(t, 25, boot, 1, StateSuspect), firstAnchor},
		},
		{
			name:    "noninitial segment-zero transition",
			sample:  Sample{Seq: 20, Boot: boot, ClockSegment: 0},
			records: []Record{bootStart, transitionRecordForTest(t, 25, boot, 0, StateAnchored), firstAnchor},
		},
		{
			name:    "missing later segment never falls back",
			sample:  Sample{Seq: 20, Boot: boot, ClockSegment: 2},
			records: []Record{bootStart, firstAnchor},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			records := test.records

			if records == nil {
				records = []Record{bootStart, firstAnchor}
			}

			if anchor, ok := BuildAnchorIndex(records).AnchorFor(test.sample); ok {
				t.Fatalf("unexpected fallback to anchor sequence %d", anchor.Seq)
			}
		})
	}
}

func TestAnchorIndexExactSegmentZeroAnchorTakesPrecedence(t *testing.T) {
	boot := BootID{4}
	first := anchorRecord(t, 20, boot, 0, 1000, 1800000000000)
	later := anchorRecord(t, 30, boot, 1, 2000, 1800000001000)
	index := BuildAnchorIndex([]Record{later, first})

	anchor, ok := index.AnchorFor(Sample{Seq: 15, Boot: boot, ClockSegment: 0})

	if !ok || anchor.Seq != first.Seq {
		t.Fatalf("exact segment-zero anchor=(%+v, %t), want sequence %d", anchor, ok, first.Seq)
	}
}

func TestMapUTCRejectsOverflowAndOutOfRangeCalendarValues(t *testing.T) {
	for _, test := range []struct {
		name   string
		anchor Anchor
		ms     int64
	}{
		{name: "elapsed subtraction overflow", anchor: Anchor{ElapsedMs: math.MinInt64}, ms: math.MaxInt64},
		{name: "upper calendar range", anchor: Anchor{UTCMs: 4102444800000}, ms: 1},
		{name: "lower calendar range", anchor: Anchor{UTCMs: -2208988800000}, ms: -1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := MapUTC(test.anchor, test.ms); err == nil {
				t.Fatal("out-of-range mapping accepted")
			}
		})
	}

	anchor := Anchor{ElapsedMs: 1000, UTCMs: 1800000000000}
	got, err := MapUTC(anchor, -1000)
	if err != nil || got != 1799999998000 {
		t.Fatalf("negative elapsed offset mapped to %d, error=%v", got, err)
	}
}

func TestSampleExpiredUsesStrictCutoffWithoutIntegerOverflow(t *testing.T) {
	const retention = 30 * 24 * time.Hour
	now := int64(1800000000000)
	input := RetentionInput{TrustedNowMs: &now}

	for _, test := range []struct {
		name   string
		mapped int64
		want   bool
	}{
		{name: "cutoff equality", mapped: now - retention.Milliseconds(), want: false},
		{name: "one millisecond older", mapped: now - retention.Milliseconds() - 1, want: true},
		{name: "one millisecond newer", mapped: now - retention.Milliseconds() + 1, want: false},
		{name: "subtraction overflow still expires", mapped: math.MinInt64, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := SampleExpired(Sample{}, &test.mapped, input, retention); got != test.want {
				t.Fatalf("expired=%t, want %t", got, test.want)
			}
		})
	}

	latest := int64(math.MaxInt64)
	input = RetentionInput{LatestElapsed: map[BootID]int64{{9}: latest}}

	if !SampleExpired(Sample{Boot: BootID{9}, ElapsedMs: math.MinInt64}, nil, input, retention) {
		t.Fatal("elapsed retention subtraction overflow did not expire old sample")
	}
}

func anchorRecord(t *testing.T, seq uint64, boot BootID, segment uint64, elapsed, utc int64) Record {
	t.Helper()

	record, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: segment, ElapsedMs: elapsed, UTCMs: utc})
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = seq

	return record
}

func bootStartRecord(t *testing.T, seq uint64, boot BootID, elapsed int64) Record {
	t.Helper()

	record, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: elapsed})
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = seq

	return record
}

func transitionRecordForTest(t *testing.T, seq uint64, boot BootID, segment uint64, state TransitionState) Record {
	t.Helper()

	record, err := PrepareClockTransition(ClockTransition{Boot: boot, ClockSegment: segment, State: state})
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = seq

	return record
}
