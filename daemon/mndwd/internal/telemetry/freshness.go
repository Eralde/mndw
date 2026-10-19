package telemetry

import (
	"context"
	"errors"
	"sync"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

// ClockMetadata describes the calendar trust of one published snapshot.
type ClockMetadata struct {
	State          string `json:"state"`
	HistoryEndMs   *int64 `json:"historyEndMs"`
	HistoryCurrent bool   `json:"historyCurrent"`
	ReplayPending  bool   `json:"replayPending"`
}

// ErrNoExpectedSlot reports that no completed acquisition slot can be expected
// at this publication cutoff, so freshness must be reported as false.
var ErrNoExpectedSlot = errors.New("telemetry: no expected slot at this cutoff")

// ExpectedSlot returns the newest acquisition deadline whose sync deadline has
// elapsed by the publication cutoff, mapped to UTC and floored to the tier's
// completed slot boundary. It never slides forward to hide a failed poll.
func ExpectedSlot(
	cutoffElapsedMs int64,
	firstAcquireElapsedMs int64,
	acquire time.Duration,
	unsynced time.Duration,
	tier time.Duration,
	anchor journal.Anchor,
) (int64, bool) {
	if acquire <= 0 || tier <= 0 {
		return 0, false
	}

	acquireMs := acquire.Milliseconds()
	unsyncedMs := unsynced.Milliseconds()

	if acquireMs <= 0 || unsyncedMs < 0 {
		return 0, false
	}

	var best int64
	found := false

	for slot := firstAcquireElapsedMs; ; slot += acquireMs {
		if slot > cutoffElapsedMs {
			break
		}

		if slot+unsyncedMs > cutoffElapsedMs {
			continue
		}

		best = slot
		found = true

		next, ok := checkedAddInt64(slot, acquireMs)

		if !ok {
			break
		}

		_ = next
	}

	if !found {
		return 0, false
	}

	mapped, err := clock.MapUTC(anchor, best)
	if err != nil {
		return 0, false
	}

	return clock.AlignSlot(mapped, tier), true
}

// clockMetadata builds response metadata from a snapshot end and pipeline state.
func clockMetadata(state clock.State, historyEndMs *int64, current, replayPending bool) *ClockMetadata {
	return &ClockMetadata{
		State:          string(state),
		HistoryEndMs:   historyEndMs,
		HistoryCurrent: current,
		ReplayPending:  replayPending,
	}
}

// snapshotRefresher is the pipeline-owned loop boundary for chart refresh. HTTP
// handlers never call it.
type snapshotRefresher struct {
	cache  *SnapshotCache
	status func() PipelineStatus

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
}

// Refresh republishes chart data projected from raw history.
func (r *snapshotRefresher) Refresh(ctx context.Context, status PipelineStatus) error {
	snapshot, err := r.cache.Refresh(ctx, status)
	if err != nil {
		return err
	}

	if snapshot == nil {
		return nil
	}

	return nil
}

// Close cancels and joins an in-flight refresh.
func (r *snapshotRefresher) Close(ctx context.Context) error {
	r.mu.Lock()

	cancel := r.cancel
	done := r.done
	r.started = false
	r.cancel = nil
	r.done = nil

	r.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	if done == nil {
		return nil
	}

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
