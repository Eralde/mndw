package telemetry

import (
	"context"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

func TestSnapshotFineWindowHas480RowsAndIntervalEndTimestamps(t *testing.T) {
	now := time.Date(2026, time.October, 18, 12, 1, 0, 0, time.UTC)
	history, cache := newProjectionFixture(t, now)
	fineEnd := now.Truncate(3 * time.Minute)
	rowStart := fineEnd.Add(-3 * time.Minute)

	applyProjectionRows(t, history, []SlotUpdate{
		{Series: 1, Row: Row{Slot: rowStart, Sequence: 1, Values: []Value{{V: 22, Known: true}, {V: 31, Known: true}}}},
		{Series: 2, Row: Row{Slot: rowStart, Sequence: 2, Values: []Value{{V: 42_000, Known: true}}}},
	})

	snapshot, err := cache.Refresh(context.Background(), PipelineStatus{})
	if err != nil {
		t.Fatal(err)
	}

	cpu := snapshot.Keys["cpu"].Tiers["fine"]

	if cpu.StepMs != 180_000 || len(cpu.Samples) != 480 {
		t.Fatalf("fine tier step/rows = %d/%d, want 180000/480", cpu.StepMs, len(cpu.Samples))
	}

	if want := fineEnd.Add(-24 * time.Hour).Add(3 * time.Minute).UnixMilli(); cpu.Samples[0].Timestamp != want {
		t.Fatalf("first interval end = %d, want %d", cpu.Samples[0].Timestamp, want)
	}

	if got := cpu.Samples[len(cpu.Samples)-1].Timestamp; got != fineEnd.UnixMilli() {
		t.Fatalf("last interval end = %d, want %d", got, fineEnd.UnixMilli())
	}

	if cpu.Samples[0].OK || cpu.Samples[0].Mean != nil {
		t.Fatalf("absent slot should be unknown: %+v", cpu.Samples[0])
	}

	last := cpu.Samples[len(cpu.Samples)-1]

	if !last.OK || last.Mean == nil || *last.Mean != 22 || last.Min == nil || *last.Min != 22 || last.Max == nil || *last.Max != 22 {
		t.Fatalf("known fine sample = %+v", last)
	}

	if got := snapshot.Keys["temp"].Tiers["fine"].Samples[len(cpu.Samples)-1].Mean; got == nil || *got != 42 {
		t.Fatalf("temperature sample = %v, want 42 Celsius", got)
	}
}

func TestSnapshotCoarseAggregatesCompleteHoursWithPerValueCoverage(t *testing.T) {
	now := time.Date(2026, time.October, 18, 12, 37, 0, 0, time.UTC)
	history, cache := newProjectionFixture(t, now)
	coarseEnd := now.Truncate(time.Hour)
	updates := make([]SlotUpdate, 0, 60)
	sequence := uint64(0)

	for index := 0; index < 20; index++ {
		sequence++
		values := []Value{{V: 99, Known: true}, {V: 99, Known: true}}
		updates = append(updates, SlotUpdate{Series: 1, Row: Row{Slot: coarseEnd.Add(time.Duration(index) * 3 * time.Minute), Sequence: sequence, Values: values}})
	}

	for index := 0; index < 20; index++ {
		values := []Value{{}, {}}

		if index < 10 {
			values[0] = Value{V: float64(index + 1), Known: true}
		}

		if index < 9 {
			values[1] = Value{V: float64(index + 11), Known: true}
		}

		sequence++
		updates = append(updates, SlotUpdate{Series: 1, Row: Row{Slot: coarseEnd.Add(-time.Hour).Add(time.Duration(index) * 3 * time.Minute), Sequence: sequence, Values: values}})
	}

	for index := 0; index < 20; index++ {
		values := []Value{{}, {}}

		if index < 9 {
			values[0] = Value{V: float64(index + 1), Known: true}
		}

		if index < 10 {
			values[1] = Value{V: float64(index + 21), Known: true}
		}

		sequence++
		updates = append(updates, SlotUpdate{Series: 1, Row: Row{Slot: coarseEnd.Add(-2 * time.Hour).Add(time.Duration(index) * 3 * time.Minute), Sequence: sequence, Values: values}})
	}

	applyProjectionRows(t, history, updates)

	snapshot, err := cache.Refresh(context.Background(), PipelineStatus{})
	if err != nil {
		t.Fatal(err)
	}

	coarse := snapshot.Keys["cpu"].Tiers["coarse"]

	if coarse.StepMs != time.Hour.Milliseconds() || len(coarse.Samples) != 720 {
		t.Fatalf("coarse tier step/rows = %d/%d, want 3600000/720", coarse.StepMs, len(coarse.Samples))
	}

	if got := coarse.Samples[len(coarse.Samples)-1].Timestamp; got != coarseEnd.UnixMilli() {
		t.Fatalf("last complete hour end = %d, want %d", got, coarseEnd.UnixMilli())
	}

	known := coarse.Samples[len(coarse.Samples)-1]

	if !known.OK || known.Min == nil || *known.Min != 1 || known.Max == nil || *known.Max != 10 || known.Mean == nil || *known.Mean != 5.5 {
		t.Fatalf("10/20 aggregate = %+v", known)
	}

	unknown := coarse.Samples[len(coarse.Samples)-2]

	if unknown.OK || unknown.Mean != nil {
		t.Fatalf("9/20 coverage should be unknown: %+v", unknown)
	}

	ramKnown := snapshot.Keys["ram"].Tiers["coarse"].Samples[len(coarse.Samples)-2]

	if !ramKnown.OK || ramKnown.Mean == nil || *ramKnown.Mean != 25.5 {
		t.Fatalf("independent RAM aggregate = %+v", ramKnown)
	}
}

func TestSnapshotEmptyHistoryContainsUnknownWindowRows(t *testing.T) {
	now := time.Date(2026, time.October, 18, 12, 37, 0, 0, time.UTC)
	_, cache := newProjectionFixture(t, now)
	snapshot, err := cache.Refresh(context.Background(), PipelineStatus{})
	if err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"cpu", "ram", "temp"} {
		for _, tierName := range []string{"fine", "coarse"} {
			tier := snapshot.Keys[key].Tiers[tierName]
			want := 480

			if tierName == "coarse" {
				want = 720
			}

			if len(tier.Samples) != want {
				t.Fatalf("%s %s rows = %d, want %d", key, tierName, len(tier.Samples), want)
			}

			for _, sample := range tier.Samples {
				if sample.OK || sample.Mean != nil || sample.Min != nil || sample.Max != nil {
					t.Fatalf("empty history produced known sample: %+v", sample)
				}
			}
		}
	}
}

func newProjectionFixture(t *testing.T, now time.Time) (*History, *SnapshotCache) {
	t.Helper()

	history, err := NewHistory(journal.DefaultLimits(), DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	cache := NewSnapshotCache(history, func() time.Time { return now })

	cache.SetSupportedSeries(map[uint16]bool{1: true, 2: true})

	return history, cache
}

func applyProjectionRows(t *testing.T, history *History, updates []SlotUpdate) {
	t.Helper()

	if err := history.store.Apply(Batch{Updates: updates}); err != nil {
		t.Fatal(err)
	}
}
