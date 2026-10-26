package telemetry

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
	"mndwd/internal/telemetry/system"
)

func TestSnapshotGetDoesNotRefreshOrExposeMutableCacheState(t *testing.T) {
	fsys := ringtest.NewMemFS()
	stored, err := ring.Open(fsys, filepath.Join("snapshot", "system.ring"), ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = stored.Close() })

	slot := floorToStep(scenarioNowMs-10_000, ringStepMs)/ringStepMs - 1

	if err := stored.Write(slot, []float32{25, 40, 42_000}); err != nil {
		t.Fatal(err)
	}

	cache := NewSnapshotCache(time.Now, nil)

	cache.SetSupportedSeries(map[uint16]bool{2: true})
	cache.PublishView(system.View{NowMs: scenarioNowMs, Window: stored.Window})

	published := cache.snapshot

	for index := 0; index < 20; index++ {
		snapshot, err := cache.Get(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}

		if !snapshot.Keys["temp"].Supported {
			t.Fatal("snapshot should reflect registered temperature sampler")
		}

		if cache.snapshot != published {
			t.Fatal("Get replaced the published snapshot")
		}

		if snapshot == cache.snapshot {
			t.Fatal("Get returned the mutable cached snapshot")
		}

		last := snapshot.Keys["cpu"].Tiers["fine"].Samples[len(snapshot.Keys["cpu"].Tiers["fine"].Samples)-1]

		if last.Mean == nil || *last.Mean != 25 {
			t.Fatalf("published row mean = %v, want 25", last.Mean)
		}

		if index == 0 {
			*last.Mean = 99
		}
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
		Clock: &ClockMetadata{State: "suspect", HistoryEndMs: &end, ReplayPending: true},
	})

	got, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if got.Clock == nil || got.Clock.State != "suspect" || got.Clock.HistoryEndMs == nil || !got.Clock.ReplayPending {
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
