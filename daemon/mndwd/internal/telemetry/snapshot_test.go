package telemetry

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"mndw.local/rrd"
	"mndwd/internal/telemetry/clock"
)

type snapshotReader struct {
	mu      sync.Mutex
	calls   int
	err     error
	unknown bool
}

func (r *snapshotReader) FetchGroup(_ context.Context, requests []rrd.FetchRequest) ([]rrd.FetchResult, error) {
	r.mu.Lock()

	r.calls += len(requests)
	err := r.err

	r.mu.Unlock()

	if err != nil {
		return nil, err
	}

	results := make([]rrd.FetchResult, 0, len(requests))

	for _, request := range requests {
		values := []rrd.Value{rrd.Known(20), rrd.Known(40)}

		if r.unknown {
			values = []rrd.Value{rrd.Unknown}
		}

		results = append(results, rrd.FetchResult{
			Start:   request.Start,
			End:     request.End,
			Step:    request.Resolution,
			DSNames: []string{"cpu", "ram"},
			Rows: []rrd.FetchRow{{
				Timestamp: request.End,
				Values:    values,
			}},
		})
	}

	return results, nil
}

func (r *snapshotReader) Calls() int {
	r.mu.Lock()

	defer r.mu.Unlock()

	return r.calls
}

func TestSnapshotCacheRefreshesBothFilesOncePerWindow(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	cache.SetSupportedSeries(map[uint16]bool{1: true, 2: true})

	// Reads never invoke RRDtool; the pipeline refresher owns that work.
	if _, err := cache.Get(context.Background(), true); err != nil {
		t.Fatal(err)
	}

	if load.Calls() != 0 || temperature.Calls() != 0 {
		t.Fatalf("read invoked RRDtool: (%d, %d)", load.Calls(), temperature.Calls())
	}

	if _, err := cache.Refresh(context.Background(), PipelineStatus{Clock: clock.View{State: clock.Anchored}}); err != nil {
		t.Fatal(err)
	}

	first, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if len(first.Keys["cpu"].Tiers["fine"].Samples) != 1 || first.Keys["cpu"].Tiers["fine"].Samples[0].Mean == nil {
		t.Fatalf("missing projected sample: %#v", first)
	}

	body, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}

	var encoded struct {
		Keys map[string]struct {
			Supported bool `json:"supported"`
		} `json:"keys"`
	}

	if err := json.Unmarshal(body, &encoded); err != nil {
		t.Fatal(err)
	}

	for _, key := range []string{"cpu", "ram", "temp"} {
		if !encoded.Keys[key].Supported {
			t.Fatalf("%s should be supported: %s", key, body)
		}
	}

	if _, err := cache.Get(context.Background(), true); err != nil {
		t.Fatal(err)
	}

	if load.Calls() != 6 || temperature.Calls() != 6 {
		t.Fatalf("fetch calls = (%d, %d), want (6, 6)", load.Calls(), temperature.Calls())
	}
}

func TestSnapshotGetDoesNotFetch(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{}
	cache := NewSnapshotCache(load, temperature, time.Now)

	for i := 0; i < 20; i++ {
		if _, err := cache.Get(context.Background(), true); err != nil {
			t.Fatal(err)
		}
	}

	if load.Calls() != 0 || temperature.Calls() != 0 {
		t.Fatal("HTTP read invoked RRDtool")
	}
}

func TestSnapshotClonePreservesClockMetadata(t *testing.T) {
	cache := NewSnapshotCache(nil, nil, nil)
	end := int64(1800000000000)

	cache.Publish(&Snapshot{
		Keys:  map[string]SeriesSnapshot{},
		Clock: &ClockMetadata{State: string(clock.Suspect), HistoryEndMs: &end, ReplayPending: true},
	})

	got, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if got.Clock == nil || got.Clock.State != string(clock.Suspect) || got.Clock.HistoryEndMs == nil || !got.Clock.ReplayPending {
		t.Fatalf("clock metadata lost during clone: %+v", got.Clock)
	}
}

func TestSnapshotRefreshErrorKeepsLastSnapshot(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	if _, err := cache.Refresh(context.Background(), PipelineStatus{}); err != nil {
		t.Fatal(err)
	}

	before, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	load.err = context.DeadlineExceeded

	if _, err := cache.Refresh(context.Background(), PipelineStatus{}); err == nil {
		t.Fatal("refresh error accepted")
	}

	after, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if len(after.Keys["cpu"].Tiers["fine"].Samples) != len(before.Keys["cpu"].Tiers["fine"].Samples) {
		t.Fatal("failed refresh replaced the last good snapshot")
	}
}

func TestSnapshotCacheMarksTemperatureUnsupportedWithoutSampler(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{unknown: true}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	if _, err := cache.Refresh(context.Background(), PipelineStatus{}); err != nil {
		t.Fatal(err)
	}

	snapshot, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	var encoded struct {
		Keys map[string]struct {
			Supported bool `json:"supported"`
		} `json:"keys"`
	}

	if err := json.Unmarshal(body, &encoded); err != nil {
		t.Fatal(err)
	}

	if encoded.Keys["temp"].Supported {
		t.Fatalf("temperature should be unsupported without registered sampler: %s", body)
	}
}

func TestSnapshotCacheMarksTemperatureSupportedWithSampler(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{unknown: true}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	cache.SetSupportedSeries(map[uint16]bool{1: true, 2: true})

	if _, err := cache.Refresh(context.Background(), PipelineStatus{}); err != nil {
		t.Fatal(err)
	}

	snapshot, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	var encoded struct {
		Keys map[string]struct {
			Supported bool `json:"supported"`
		} `json:"keys"`
	}

	if err := json.Unmarshal(body, &encoded); err != nil {
		t.Fatal(err)
	}

	if !encoded.Keys["temp"].Supported {
		t.Fatalf("temperature should be supported with registered sampler even without data: %s", body)
	}
}

func TestSnapshotCacheEmptyGetUsesSupportedSeries(t *testing.T) {
	cache := NewSnapshotCache(nil, nil, nil)

	cache.SetSupportedSeries(map[uint16]bool{1: true, 2: true})

	snapshot, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	if !snapshot.Keys["temp"].Supported {
		t.Fatal("empty snapshot should mark temp supported when sampler is registered")
	}
}

func TestSnapshotCacheThrottlesFailedRefreshes(t *testing.T) {
	load := &snapshotReader{err: context.DeadlineExceeded}
	temperature := &snapshotReader{}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	if _, err := cache.Refresh(context.Background(), PipelineStatus{}); err == nil {
		t.Fatal("expected refresh error")
	}

	snapshot, err := cache.Get(context.Background(), true)
	if err != nil {
		t.Fatalf("read after failed refresh: %v", err)
	}

	if snapshot.Clock != nil && snapshot.Clock.HistoryCurrent {
		t.Fatal("empty history reported as current")
	}

	if load.Calls() != 6 {
		t.Fatalf("failed refresh retried unexpectedly: %d calls", load.Calls())
	}
}
