package telemetry

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"mndw.local/rrd"
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

func TestSnapshotCacheMarksTemperatureUnsupportedWithoutKnownSamples(t *testing.T) {
	load := &snapshotReader{}
	temperature := &snapshotReader{unknown: true}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

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
		t.Fatalf("temperature should be unsupported: %s", body)
	}
}

func TestSnapshotCacheThrottlesFailedRefreshes(t *testing.T) {
	load := &snapshotReader{err: context.DeadlineExceeded}
	temperature := &snapshotReader{}
	now := time.Unix(1_800_000_000, 0)
	cache := NewSnapshotCache(load, temperature, func() time.Time { return now })

	if _, err := cache.Get(context.Background(), true); err == nil {
		t.Fatal("expected refresh error")
	}

	if _, err := cache.Get(context.Background(), true); err == nil {
		t.Fatal("expected refresh error")
	}

	if load.Calls() != 6 {
		t.Fatalf("failed refresh retried within age window: %d calls", load.Calls())
	}
}
