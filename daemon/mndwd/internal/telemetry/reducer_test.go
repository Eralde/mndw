package telemetry

import (
	"encoding/binary"
	"math"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

func TestReducerMapsAnchorsBeforeOrAfterSamplesAndHonorsDurableBoundary(t *testing.T) {
	boot := reducerBoot(1)
	anchor := reducerAnchorRecord(t, 2, journal.Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 600_000, UTCMs: 1_800_000_000_000})
	duplicateAnchor := reducerAnchorRecord(t, 3, journal.Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 700_000, UTCMs: 1_800_000_100_000})
	sample := reducerSampleRecord(t, 1, journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, ElapsedMs: 599_999, Values: []journal.Value{{Known: true, V: 7}, {}}})
	reducer := newTestReducer(t, 30*24*time.Hour)

	result, err := reducer.Reduce([]journal.Record{anchor, sample}, 2, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 1 || result.Batch.Updates[0].Row.Slot.UnixMilli() != 1_799_999_820_000 {
		t.Fatalf("mapped updates = %#v, want preceding 3-minute UTC slot", result.Batch.Updates)
	}

	if result.Batch.Updates[0].Row.Values[0].V != 7 || result.Batch.Updates[0].Row.Values[1].Known {
		t.Fatalf("reduced values = %#v", result.Batch.Updates[0].Row.Values)
	}

	if len(result.ReplayRequests) != 1 || result.ReplayRequests[0] != (journal.SegmentKey{Boot: boot, ClockSegment: 1}) {
		t.Fatalf("closed pending requests = %#v, want one canonical segment request", result.ReplayRequests)
	}

	// Records may arrive in a different scan order, but the sequence boundary
	// prevents a future anchor from affecting an earlier durable replay.
	result, err = reducer.Reduce([]journal.Record{sample, duplicateAnchor, anchor}, 3, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 1 || len(result.PendingSegments) != 0 || len(result.ReplayRequests) != 1 {
		t.Fatalf("replay with repeated anchor = %#v, want one mapped row and one replay request", result)
	}

	result, err = reducer.Reduce([]journal.Record{sample, anchor}, 1, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 0 || len(result.PendingSegments) != 1 || len(result.ReplayRequests) != 0 {
		t.Fatalf("pre-anchor replay = %#v, want one pending segment and no request", result)
	}
}

func TestReducerSupportsSegmentZeroAndLegacyFallback(t *testing.T) {
	bootA := reducerBoot(2)
	bootB := reducerBoot(3)
	anchorA := reducerAnchorRecord(t, 1, journal.Anchor{Boot: bootA, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	segmentZeroSample := reducerSampleRecord(t, 2, journal.Sample{Boot: bootA, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 42_000}}})
	bootStart := reducerBootStartRecord(t, 3, journal.BootStart{Boot: bootB, FirstAcquireElapsedMs: 0})
	legacySample := reducerSampleRecord(t, 4, journal.Sample{Boot: bootB, ClockSegment: 0, Series: 2, ElapsedMs: 180_000, Values: []journal.Value{{Known: true, V: 55_000}}})
	firstAnchor := reducerAnchorRecord(t, 5, journal.Anchor{Boot: bootB, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	reducer := newTestReducer(t, 30*24*time.Hour)

	result, err := reducer.Reduce([]journal.Record{firstAnchor, legacySample, bootStart, segmentZeroSample, anchorA}, 5, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 2 || len(result.PendingSegments) != 0 {
		t.Fatalf("reduced segment-zero rows = %#v", result)
	}

	if result.Batch.Updates[0].Row.Slot.UnixMilli() != 1_800_000_000_000 || result.Batch.Updates[1].Row.Slot.UnixMilli() != 1_800_000_180_000 {
		t.Fatalf("segment zero/fallback slots = %#v", result.Batch.Updates)
	}
}

func TestReducerAlignsExactAndAdjacentUTCSlotBoundaries(t *testing.T) {
	boot := reducerBoot(9)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	reducer := newTestReducer(t, 30*24*time.Hour)

	for _, test := range []struct {
		name       string
		elapsedMs  int64
		wantSlotMs int64
	}{
		{name: "one millisecond before boundary", elapsedMs: -1, wantSlotMs: 1_799_999_820_000},
		{name: "exact boundary", elapsedMs: 0, wantSlotMs: 1_800_000_000_000},
		{name: "one millisecond after boundary", elapsedMs: 1, wantSlotMs: 1_800_000_000_000},
		{name: "next exact boundary", elapsedMs: 180_000, wantSlotMs: 1_800_000_180_000},
	} {
		t.Run(test.name, func(t *testing.T) {
			sample := reducerSampleRecord(t, 2, journal.Sample{
				Boot: boot, ClockSegment: 1, Series: 2, ElapsedMs: test.elapsedMs,
				Values: []journal.Value{{Known: true, V: 1}},
			})
			result, err := reducer.Reduce([]journal.Record{anchor, sample}, 2, journal.RetentionInput{})
			if err != nil {
				t.Fatal(err)
			}

			if len(result.Batch.Updates) != 1 || result.Batch.Updates[0].Row.Slot.UnixMilli() != test.wantSlotMs {
				t.Fatalf("reduced slot = %#v, want %d", result.Batch.Updates, test.wantSlotMs)
			}
		})
	}
}

func TestReducerRejectsLegacyFallbackAcrossSuspectAndSeparatesBootSegments(t *testing.T) {
	bootA := reducerBoot(4)
	bootB := reducerBoot(5)
	bootStart := reducerBootStartRecord(t, 1, journal.BootStart{Boot: bootA})
	sampleBeforeSuspect := reducerSampleRecord(t, 2, journal.Sample{Boot: bootA, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 1}}})
	suspect := reducerTransitionRecord(t, 3, journal.ClockTransition{Boot: bootA, ClockSegment: 0, State: journal.StateSuspect})
	anchorA := reducerAnchorRecord(t, 4, journal.Anchor{Boot: bootA, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	anchorB1 := reducerAnchorRecord(t, 5, journal.Anchor{Boot: bootB, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	anchorB2 := reducerAnchorRecord(t, 6, journal.Anchor{Boot: bootB, ClockSegment: 2, ElapsedMs: 600_000, UTCMs: 1_800_001_200_000})
	sampleB1 := reducerSampleRecord(t, 7, journal.Sample{Boot: bootB, ClockSegment: 1, Series: 2, Values: []journal.Value{{Known: true, V: 2}}})
	sampleB2 := reducerSampleRecord(t, 8, journal.Sample{Boot: bootB, ClockSegment: 2, Series: 2, ElapsedMs: 600_000, Values: []journal.Value{{Known: true, V: 3}}})
	reducer := newTestReducer(t, 30*24*time.Hour)

	result, err := reducer.Reduce([]journal.Record{bootStart, sampleBeforeSuspect, suspect, anchorA, anchorB2, sampleB2, sampleB1, anchorB1}, 8, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 2 || len(result.PendingSegments) != 1 {
		t.Fatalf("reduced rows/pending = %#v", result)
	}

	if result.Batch.Updates[0].Row.Values[0].V != 2 || result.Batch.Updates[1].Row.Values[0].V != 3 {
		t.Fatalf("boot and segment values merged: %#v", result.Batch.Updates)
	}

	if _, ok := result.PendingSegments[journal.SegmentKey{Boot: bootA, ClockSegment: 0}]; !ok {
		t.Fatalf("suspect segment not left pending: %#v", result.PendingSegments)
	}
}

func TestReducerResolvesWholeVectorConflictsAndIgnoresPublication(t *testing.T) {
	boot := reducerBoot(6)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	first := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, Values: []journal.Value{{Known: true, V: 10}, {Known: true, V: 20}}})
	stale := reducerSampleRecord(t, 3, journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, Values: []journal.Value{{Known: true, V: 30}, {Known: true, V: 40}}})
	winner := reducerSampleRecord(t, 4, journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, Values: []journal.Value{{Known: true, V: 50}, {}}})
	publication, err := journal.PreparePublication(journal.Publication{SampleThrough: 4, AnchorThrough: 1})
	if err != nil {
		t.Fatal(err)
	}

	publication.Seq = 5
	reducer := newTestReducer(t, 30*24*time.Hour)
	result, err := reducer.Reduce([]journal.Record{anchor, first, stale, winner, publication}, 5, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Batch.Updates) != 1 {
		t.Fatalf("updates = %#v, want one winning slot", result.Batch.Updates)
	}

	values := result.Batch.Updates[0].Row.Values

	if values[0].V != 50 || !values[0].Known || values[1].Known {
		t.Fatalf("winning vector = %#v", values)
	}

	store := newTestRawStore(t, 30*24*time.Hour, DefaultSeriesSpecs()[0])

	if err := store.Apply(result.Batch); err != nil {
		t.Fatal(err)
	}

	if err := store.Apply(result.Batch); err != nil {
		t.Fatal(err)
	}

	rows, err := store.Read(Query{Series: 1, Start: result.Batch.Updates[0].Row.Slot, End: result.Batch.Updates[0].Row.Slot.Add(3 * time.Minute)})
	if err != nil || len(rows) != 1 || rows[0].Values[0].V != 50 || rows[0].Values[1].Known {
		t.Fatalf("idempotent apply rows=%#v err=%v", rows, err)
	}
}

func TestReducerMakesNonFiniteKnownValueUnknownWithoutAffectingSibling(t *testing.T) {
	boot := reducerBoot(7)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 1, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, Values: []journal.Value{{Known: true, V: 1}, {Known: true, V: 2}}})

	// The decoder accepts IEEE payload bits; the reducer must still protect its
	// in-memory domain if a future or damaged source supplies a non-finite value.
	binary.LittleEndian.PutUint64(sample.Payload[37:45], math.Float64bits(math.NaN()))

	reducer := newTestReducer(t, 30*24*time.Hour)
	result, err := reducer.Reduce([]journal.Record{anchor, sample}, 2, journal.RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	values := result.Batch.Updates[0].Row.Values

	if values[0].Known || !values[1].Known || values[1].V != 2 {
		t.Fatalf("reduced values = %#v", values)
	}
}

func TestReducerExpiryMatchesJournalAtCutoffAndAdjacentMillisecond(t *testing.T) {
	boot := reducerBoot(8)
	const retention = 6 * time.Minute
	const mapped = int64(1_800_000_000_000)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 1, UTCMs: mapped})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 1, Series: 2, Values: []journal.Value{{Known: true, V: 5}}})
	reducer := newTestReducer(t, retention)

	for _, test := range []struct {
		name     string
		now      int64
		wantRows int
	}{
		{name: "equal cutoff remains", now: mapped + retention.Milliseconds(), wantRows: 1},
		{name: "one millisecond past cutoff expires", now: mapped + retention.Milliseconds() + 1, wantRows: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := journal.RetentionInput{TrustedNowMs: &test.now}
			mappedUTC := mapped
			gotExpired := journal.SampleExpired(journal.Sample{Seq: 2, Boot: boot, ClockSegment: 1}, &mappedUTC, input, retention)
			result, err := reducer.Reduce([]journal.Record{anchor, sample}, 2, input)
			if err != nil {
				t.Fatal(err)
			}

			if gotExpired != (test.wantRows == 0) || len(result.Batch.Updates) != test.wantRows {
				t.Fatalf("expired=%v rows=%d, want expired=%v rows=%d", gotExpired, len(result.Batch.Updates), test.wantRows == 0, test.wantRows)
			}
		})
	}
}

func newTestReducer(t *testing.T, retention time.Duration) *Reducer {
	t.Helper()

	limits := journal.DefaultLimits()
	limits.Retention = retention
	reducer, err := NewReducer(limits, DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	return reducer
}

func reducerBoot(last byte) journal.BootID {
	var boot journal.BootID
	boot[15] = last

	return boot
}

func reducerSampleRecord(t *testing.T, sequence uint64, sample journal.Sample) journal.Record {
	t.Helper()

	record, err := journal.PrepareSample(sample)
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = sequence

	return record
}

func reducerAnchorRecord(t *testing.T, sequence uint64, anchor journal.Anchor) journal.Record {
	t.Helper()

	record, err := journal.PrepareAnchor(anchor)
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = sequence

	return record
}

func reducerBootStartRecord(t *testing.T, sequence uint64, start journal.BootStart) journal.Record {
	t.Helper()

	record, err := journal.PrepareBootStart(start)
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = sequence

	return record
}

func reducerTransitionRecord(t *testing.T, sequence uint64, transition journal.ClockTransition) journal.Record {
	t.Helper()

	record, err := journal.PrepareClockTransition(transition)
	if err != nil {
		t.Fatal(err)
	}

	record.Seq = sequence

	return record
}
