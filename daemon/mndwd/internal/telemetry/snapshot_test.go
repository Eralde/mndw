package telemetry

import (
	"context"
	"testing"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

func TestSnapshotGetDoesNotRefreshOrExposeMutableCacheState(t *testing.T) {
	history, err := NewHistory(journal.DefaultLimits(), DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	cache := NewSnapshotCache(history, time.Now)

	cache.SetSupportedSeries(map[uint16]bool{2: true})

	for index := 0; index < 20; index++ {
		snapshot, err := cache.Get(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}

		if !snapshot.Keys["temp"].Supported {
			t.Fatal("empty snapshot should reflect registered temperature sampler")
		}
	}

	if cache.snapshot != nil {
		t.Fatal("HTTP get unexpectedly refreshed or published the cache")
	}
}

func TestSnapshotClonePreservesAndCopiesClockMetadata(t *testing.T) {
	cache := NewSnapshotCache(nil, nil)
	end := int64(1_800_000_000_000)
	mean := 12.0

	cache.Publish(&Snapshot{
		Keys: map[string]SeriesSnapshot{
			"cpu": {Tiers: map[string]TierSnapshot{
				"fine": {Samples: []Sample{{Timestamp: end, Mean: &mean, OK: true}}},
			}},
		},
		Clock: &ClockMetadata{State: string(clock.Suspect), HistoryEndMs: &end, ReplayPending: true},
	})

	got, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if got.Clock == nil || got.Clock.State != string(clock.Suspect) || got.Clock.HistoryEndMs == nil || !got.Clock.ReplayPending {
		t.Fatalf("clock metadata lost during clone: %+v", got.Clock)
	}

	*got.Keys["cpu"].Tiers["fine"].Samples[0].Mean = 99
	second, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if value := *second.Keys["cpu"].Tiers["fine"].Samples[0].Mean; value != 12 {
		t.Fatalf("caller mutated cached snapshot value to %v", value)
	}
}

func TestSnapshotCanceledRefreshKeepsLastPublishedSnapshot(t *testing.T) {
	cache := NewSnapshotCache(nil, nil)

	cache.Publish(&Snapshot{Keys: map[string]SeriesSnapshot{"cpu": {
		Tiers: map[string]TierSnapshot{"fine": {Samples: []Sample{{Timestamp: 10, Mean: floatPointer(20), OK: true}}}},
	}}})

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	if _, err := cache.Refresh(ctx, PipelineStatus{}); err == nil {
		t.Fatal("canceled refresh succeeded")
	}

	got, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if value := *got.Keys["cpu"].Tiers["fine"].Samples[0].Mean; value != 20 {
		t.Fatalf("canceled refresh replaced last snapshot with %v", value)
	}
}

func TestSnapshotRefreshMarksHistoryEndFromKnownRowsOnly(t *testing.T) {
	now := time.Date(2026, time.October, 18, 12, 1, 0, 0, time.UTC)
	history, cache := newProjectionFixture(t, now)

	if _, err := cache.Refresh(context.Background(), PipelineStatus{Clock: clock.View{State: clock.Anchored}}); err != nil {
		t.Fatal(err)
	}

	empty, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if empty.Clock == nil || empty.Clock.HistoryEndMs != nil || empty.Clock.HistoryCurrent {
		t.Fatalf("empty projected window reported dated history: %+v", empty.Clock)
	}

	slot := now.Truncate(3 * time.Minute).Add(-3 * time.Minute)

	applyProjectionRows(t, history, []SlotUpdate{{Series: 1, Row: Row{
		Slot: slot, Sequence: 1, Values: []Value{{V: 25, Known: true}, {}},
	}}})

	if _, err := cache.Refresh(context.Background(), PipelineStatus{Clock: clock.View{State: clock.Anchored}}); err != nil {
		t.Fatal(err)
	}

	withHistory, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if withHistory.Clock == nil || withHistory.Clock.HistoryEndMs == nil || *withHistory.Clock.HistoryEndMs != slot.Add(3*time.Minute).UnixMilli() {
		t.Fatalf("known raw row missing from history end: %+v", withHistory.Clock)
	}
}
