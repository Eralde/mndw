package telemetry

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	telemetryclock "mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
	"mndwd/internal/telemetry/publication"
)

func TestSyncDeadlineDoesNotDependOnFuturePolls(t *testing.T) {
	if got := SyncDeadline(180000, 15*time.Minute); got != 1080000 {
		t.Fatalf("sync deadline=%d", got)
	}
}

func TestNextDeadlineKeepsOriginPhase(t *testing.T) {
	const origin = int64(180000)
	const period = int64(180000)

	if got := nextDeadline(origin, period, 180000); got != 180000 {
		t.Fatalf("at origin=%d", got)
	}

	if got := nextDeadline(origin, period, 200000); got != 360000 {
		t.Fatalf("mid slot=%d", got)
	}

	if got := nextDeadline(origin, period, 540000); got != 540000 {
		t.Fatalf("on slot=%d", got)
	}

	// A restart must not reset the phase to process start time.
	if got := nextDeadline(origin, period, 900001); got != 1080000 {
		t.Fatalf("after restart=%d", got)
	}
}

// fakeClock advances boot-relative time deterministically.
type fakeClock struct {
	mu      sync.Mutex
	boot    journal.BootID
	elapsed int64
	wall    int64
}

func (c *fakeClock) Read() (telemetryclock.Reading, error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	return telemetryclock.Reading{Boot: c.boot, ElapsedMs: c.elapsed, WallMs: c.wall}, nil
}

func (c *fakeClock) advance(delta int64) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.elapsed += delta
	c.wall += delta
}

// recordingSampler returns a fixed value and counts polls.
type recordingSampler struct {
	values []Value
	calls  int
	err    error
}

func (s *recordingSampler) Poll(context.Context) ([]Value, error) {
	s.calls++

	if s.err != nil {
		return nil, s.err
	}

	return s.values, nil
}

// stepWaiter lets a test drive the scheduler loop one tick at a time.
type stepWaiter struct {
	deadlines chan int64
}

func (w *stepWaiter) wait(context.Context, int64) error { return nil }

type recordingPublicationWorker struct {
	recoverCalls int
	cycleCalls   int
	runErr       error
}

func (w *recordingPublicationWorker) Recover(context.Context) error {
	w.recoverCalls++

	return nil
}

func (w *recordingPublicationWorker) RunCycle(context.Context, publication.Cycle) error {
	w.cycleCalls++

	return w.runErr
}

func (w *recordingPublicationWorker) CloseClean(context.Context) error { return nil }

type recordingSnapshotRefresher struct {
	mu    sync.Mutex
	calls int
}

func (r *recordingSnapshotRefresher) Refresh(context.Context, PipelineStatus) error {
	r.mu.Lock()

	r.calls++

	r.mu.Unlock()

	return nil
}

func (r *recordingSnapshotRefresher) callCount() int {
	r.mu.Lock()

	defer r.mu.Unlock()

	return r.calls
}

func (r *recordingSnapshotRefresher) Close(context.Context) error { return nil }

func newTestProvider(t *testing.T) journal.StorageProvider {
	t.Helper()

	paths, err := journal.PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = provider.Close(context.Background()) })

	return provider
}

func TestPipelineRecoversPublicationWorkerBeforeScheduling(t *testing.T) {
	provider := newTestProvider(t)
	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}
	worker := &recordingPublicationWorker{}
	pipeline, err := NewPipeline(DefaultPolicy(), clock, nil, provider,
		map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithPublicationWorker(worker),
		WithWaitUntil(func(ctx context.Context, _ int64) error { return context.Canceled }),
	)
	if err != nil {
		t.Fatal(err)
	}

	if err := pipeline.Run(context.Background()); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}

	if worker.recoverCalls != 1 {
		t.Fatalf("Recover calls=%d", worker.recoverCalls)
	}
}

func TestPipelinePublicationFailureRefreshesRecoveredSnapshot(t *testing.T) {
	provider := newTestProvider(t)
	publicationErr := errors.New("rrd: update timestamp is not strictly chronological")
	worker := &recordingPublicationWorker{runErr: publicationErr}
	refresher := &recordingSnapshotRefresher{}
	pipeline, err := NewPipeline(DefaultPolicy(), &fakeClock{boot: journal.BootID{1}}, nil, provider,
		map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithPublicationWorker(worker), WithSnapshotRefresher(refresher))
	if err != nil {
		t.Fatal(err)
	}

	pipeline.publicationBus <- publication.Cycle{}

	close(pipeline.publicationBus)
	pipeline.runPublication(context.Background(), make(chan struct{}))

	if refresher.calls != 1 {
		t.Fatalf("refresh calls=%d, want 1", refresher.calls)
	}

	status := pipeline.Status()

	if status.Error != publicationErr.Error() {
		t.Fatalf("pipeline error=%q, want %q", status.Error, publicationErr.Error())
	}

	diagnostic := sessionStatus(status)

	if diagnostic.Error != publicationErr.Error() {
		t.Fatalf("session error=%q, want %q", diagnostic.Error, publicationErr.Error())
	}
}

func TestPipelineFlushSynchronizesPreviouslyAppendedRecords(t *testing.T) {
	provider := newTestProvider(t)
	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}
	pipeline, err := NewPipeline(DefaultPolicy(), clock, nil, provider,
		map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithWaitUntil(func(context.Context, int64) error { return nil }),
	)
	if err != nil {
		t.Fatal(err)
	}

	pipeline.acquire(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 180000})

	if err := pipeline.flush(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 180000}); err != nil {
		t.Fatal(err)
	}

	if pipeline.Status().PendingSamples != 0 {
		t.Fatal("append left samples queued")
	}

	if err := pipeline.flush(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 360000}); err != nil {
		t.Fatal(err)
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	if lease.Result.Writer.DurableThrough() == 0 {
		t.Fatal("durability deadline did not synchronize appended records")
	}
}

func TestPipelineRefreshRequestRunsWithoutPublicationCycle(t *testing.T) {
	provider := newTestProvider(t)
	refresher := &recordingSnapshotRefresher{}
	pipeline, err := NewPipeline(DefaultPolicy(), &fakeClock{boot: journal.BootID{1}}, nil, provider,
		map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithSnapshotRefresher(refresher))
	if err != nil {
		t.Fatal(err)
	}

	// Repeated requests coalesce into one pending refresh and never block.
	pipeline.requestSnapshotRefresh()
	pipeline.requestSnapshotRefresh()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go pipeline.runPublication(ctx, done)

	deadline := time.Now().Add(time.Second)

	for refresher.callCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}

	cancel()
	close(pipeline.publicationBus)
	<-done

	if got := refresher.callCount(); got != 1 {
		t.Fatalf("refresh calls=%d, want 1", got)
	}
}

func TestPipelineAppliesRawHistoryOnlyAfterJournalSync(t *testing.T) {
	provider := newTestProvider(t)
	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	boot := journal.BootID{41}
	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	if err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{anchor}); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	policy := DefaultPolicy()
	history, err := NewHistory(policy.Journal, DefaultSeriesSpecs())
	if err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if err := history.restore(context.Background(), journal.StatusReady, lease.Result.Reader, lease.Result.Writer, journal.RetentionInput{}); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	clock := &fakeClock{boot: boot, elapsed: 180_000, wall: 1_800_000_000_000}
	pipeline, err := NewPipeline(policy, clock, nil, provider,
		map[uint16]Sampler{2: &recordingSampler{values: []Value{{Known: true, V: 52_000}}}},
		WithHistory(history), WithSnapshotRefresher(&recordingSnapshotRefresher{}))
	if err != nil {
		t.Fatal(err)
	}

	sample, err := journal.PrepareSample(journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2, ElapsedMs: 0,
		Values: []journal.Value{{Known: true, V: 52_000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	pipeline.enqueue([]journal.Record{sample}, 1_000)

	if err := pipeline.flush(context.Background(), telemetryclock.Reading{Boot: boot, ElapsedMs: 1_000}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 1 {
		t.Fatalf("unsynced history through=%d, want 1", history.AppliedThrough())
	}

	assertHistoryUnknown(t, history, 1_800_000_000_000)

	deadline := 1_000 + policy.MaxUnsynced.Milliseconds()

	if err := pipeline.flush(context.Background(), telemetryclock.Reading{Boot: boot, ElapsedMs: deadline}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("synced history through=%d, want 2", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 52_000)

	select {
	case <-pipeline.refreshBus:
	default:
		t.Fatal("applied durable history did not request a snapshot refresh")
	}
}

func TestPipelineMaintenanceRebuildsChangedInventory(t *testing.T) {
	pipeline, history, writer, boot, anchorUTC := newMaintenanceHistoryFixture(t)

	assertHistoryValue(t, history, anchorUTC, 61_000)
	assertHistoryValue(t, history, anchorUTC+18*time.Minute.Milliseconds(), 62_000)

	if ok := pipeline.maintain(context.Background(), telemetryclock.Reading{
		Boot: boot, ElapsedMs: 20 * time.Minute.Milliseconds(),
		WallMs: anchorUTC + 35*time.Minute.Milliseconds(),
	}); !ok {
		t.Fatal("successful post-maintenance rebuild suppressed the next publication")
	}

	assertHistoryUnknown(t, history, anchorUTC)
	assertHistoryValue(t, history, anchorUTC+18*time.Minute.Milliseconds(), 62_000)

	if history.AppliedThrough() != writer.DurableThrough() {
		t.Fatalf("history through=%d, durable through=%d after maintenance", history.AppliedThrough(), writer.DurableThrough())
	}
}

func TestPipelineMaintenanceRebuildsAfterPartialMutationError(t *testing.T) {
	pipeline, history, writer, boot, anchorUTC := newMaintenanceHistoryFixture(t)
	ctx := &oneShotErrorContext{Context: context.Background(), err: errors.New("reported after compaction")}

	if ok := pipeline.maintain(ctx, telemetryclock.Reading{
		Boot: boot, ElapsedMs: 20 * time.Minute.Milliseconds(),
		WallMs: anchorUTC + 35*time.Minute.Milliseconds(),
	}); !ok {
		t.Fatal("partial maintenance mutation prevented a successful final-inventory rebuild")
	}

	assertHistoryUnknown(t, history, anchorUTC)
	assertHistoryValue(t, history, anchorUTC+18*time.Minute.Milliseconds(), 62_000)

	if history.AppliedThrough() != writer.DurableThrough() {
		t.Fatalf("history through=%d, durable through=%d after partial maintenance", history.AppliedThrough(), writer.DurableThrough())
	}
}

func TestPipelineMaintenanceDoesNotRebuildUnchangedInventory(t *testing.T) {
	limits := journal.DefaultLimits()
	paths, err := journal.PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = provider.Close(context.Background()) })

	history, err := NewHistory(limits, DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if err := history.restore(context.Background(), journal.StatusReady, lease.Result.Reader, lease.Result.Writer, journal.RetentionInput{}); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	pipeline, err := NewPipeline(DefaultPolicy(), &fakeClock{}, nil, provider,
		map[uint16]Sampler{2: &recordingSampler{values: []Value{{Known: true, V: 1}}}}, WithHistory(history))
	if err != nil {
		t.Fatal(err)
	}

	store := history.store

	if ok := pipeline.maintain(context.Background(), telemetryclock.Reading{Boot: journal.BootID{1}}); !ok {
		t.Fatal("unchanged inventory unexpectedly suppressed publication")
	}

	if history.store != store {
		t.Fatal("unchanged inventory triggered a history rebuild")
	}
}

func newMaintenanceHistoryFixture(t *testing.T) (*Pipeline, *History, *journal.Storage, journal.BootID, int64) {
	t.Helper()

	limits := journal.DefaultLimits()
	limits.Retention = 30 * time.Minute
	limits.SegmentBytes = 256
	paths, err := journal.PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	opened, err := provider.Reopen(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = provider.Close(context.Background()) })

	boot := journal.BootID{62}
	anchorUTC := int64(1_800_000_000_000)
	start, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 0})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 0, UTCMs: anchorUTC})
	if err != nil {
		t.Fatal(err)
	}

	oldSample, err := journal.PrepareSample(journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2, ElapsedMs: 0,
		Values: []journal.Value{{Known: true, V: 61_000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	liveSample, err := journal.PrepareSample(journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2, ElapsedMs: 20 * time.Minute.Milliseconds(),
		Values: []journal.Value{{Known: true, V: 62_000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := opened.Writer.Append(context.Background(), []journal.Record{start, anchor, oldSample, liveSample}); err != nil {
		t.Fatal(err)
	}

	if _, err := opened.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(opened.Writer.Manifest().Segments) < 2 {
		t.Fatalf("fixture did not seal the old sample segment: %+v", opened.Writer.Manifest().Segments)
	}

	history, err := NewHistory(limits, DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	if err := history.restore(context.Background(), journal.StatusReady, opened.Reader, opened.Writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	policy := DefaultPolicy()
	policy.Journal = limits
	pipeline, err := NewPipeline(policy, &fakeClock{boot: boot}, nil, provider,
		map[uint16]Sampler{2: &recordingSampler{values: []Value{{Known: true, V: 1}}}}, WithHistory(history))
	if err != nil {
		t.Fatal(err)
	}

	pipeline.tracker.Install(telemetryclock.View{State: telemetryclock.Anchored, Boot: boot, Segment: 0})

	return pipeline, history, opened.Writer, boot, anchorUTC
}

type oneShotErrorContext struct {
	context.Context
	mu  sync.Mutex
	err error
}

func (c *oneShotErrorContext) Err() error {
	c.mu.Lock()

	defer c.mu.Unlock()

	if c.err != nil {
		err := c.err
		c.err = nil

		return err
	}

	return c.Context.Err()
}

// unavailableProvider reports unavailable storage so no handle is granted.
type unavailableProvider struct {
	status journal.RecoveryStatus
	leases int
}

func (p *unavailableProvider) CurrentStatus() journal.RecoveryStatus { return p.status }
func (p *unavailableProvider) Acquire(context.Context) (journal.StorageLease, error) {
	p.leases++

	return journal.StorageLease{}, nil
}
func (p *unavailableProvider) Reopen(context.Context) (journal.OpenResult, error) {
	return journal.OpenResult{Status: p.status}, nil
}
func (p *unavailableProvider) Close(context.Context) error { return nil }

func TestPipelineJournalsSamplesAndSyncs(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer func() { _ = provider.Close(context.Background()) }()

	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}
	load := &recordingSampler{values: []Value{{Known: true, V: 20}, {Known: true, V: 40}}}
	policy := DefaultPolicy()

	ticks := make(chan struct{})
	pipeline, err := NewPipeline(policy, clock, nil, provider, map[uint16]Sampler{1: load},
		WithWaitUntil(func(ctx context.Context, _ int64) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case ticks <- struct{}{}:
				return nil
			}
		}))
	if err != nil {
		t.Fatal(err)
	}

	_ = ValidatePolicy(policy)

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error)

	go func() { runDone <- pipeline.Run(ctx) }()

	for i := 0; i < 3; i++ {
		<-ticks
		clock.advance(180000)
	}

	cancel()
	<-runDone

	if load.calls == 0 {
		t.Fatal("sampler never polled")
	}

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = lease.Close() }()

	kinds := map[journal.Kind]int{}
	var samples int

	if err := lease.Result.Writer.Scan(context.Background(), 0, func(record journal.Record) error {
		kinds[record.Kind]++

		if record.Kind == journal.KindSample {
			samples++
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if kinds[journal.KindBootStart] != 1 {
		t.Fatalf("boot start records=%d", kinds[journal.KindBootStart])
	}

	if samples == 0 {
		t.Fatal("no samples journaled")
	}
}

func TestPipelineKeepsBoundedQueueWhenStorageUnavailable(t *testing.T) {
	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 1000, wall: 1800000000000}
	sampler := &recordingSampler{values: []Value{{Known: true, V: 1}}}
	policy := DefaultPolicy()
	policy.QueueBytes = 512

	provider := &unavailableProvider{status: journal.RecoveryStatus{Mode: journal.StatusUnavailable}}
	pipeline, err := NewPipeline(policy, clock, nil, provider, map[uint16]Sampler{1: sampler},
		WithWaitUntil(func(context.Context, int64) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 50; i++ {
		pipeline.acquire(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: clock.elapsed})
		clock.advance(1000)
	}

	if err := pipeline.flush(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: clock.elapsed}); err != nil {
		t.Fatalf("flush with unavailable storage: %v", err)
	}

	status := pipeline.Status()

	if status.PendingBytes > policy.QueueBytes {
		t.Fatalf("queue grew unbounded: %d", status.PendingBytes)
	}

	if status.PendingSamples == 0 {
		t.Fatal("no records retained in RAM")
	}

	if status.Loss["5"] == 0 {
		t.Fatalf("queue overflow not counted: %+v", status.Loss)
	}

	if status.Storage.Mode != journal.StatusUnavailable {
		t.Fatalf("status=%+v", status.Storage)
	}
}

func TestPipelineReusesPersistedAcquisitionOrigin(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer func() { _ = provider.Close(context.Background()) }()

	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}
	first, err := NewPipeline(DefaultPolicy(), clock, nil, provider, map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithWaitUntil(func(context.Context, int64) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}

	first.acquire(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 180000})

	if err := first.flush(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 180000}); err != nil {
		t.Fatal(err)
	}

	origin := first.origin

	if origin == 0 {
		t.Fatal("acquisition origin not established")
	}

	// A new pipeline over the same storage restores the origin instead of
	// establishing a fresh schedule from process start time.
	clock.advance(600000)

	second, err := NewPipeline(DefaultPolicy(), clock, nil, provider, map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithWaitUntil(func(context.Context, int64) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}

	if err := second.recoverBootStart(context.Background()); err != nil {
		t.Fatal(err)
	}

	if second.origin != origin {
		t.Fatalf("origin reset: %d then %d", origin, second.origin)
	}
}

func TestTrackerRecoverySelectsFirstAcceptedAnchor(t *testing.T) {
	provider := newTestProvider(t)
	boot := journal.BootID{7}
	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	start, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}

	firstAnchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 1000, UTCMs: 1800000000000})
	if err != nil {
		t.Fatal(err)
	}

	transition, err := journal.PrepareClockTransition(journal.ClockTransition{
		Boot: boot, ClockSegment: 0, State: journal.StateAnchored, ConsumedEvidenceID: "first",
	})
	if err != nil {
		t.Fatal(err)
	}

	secondAnchor, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 2000, UTCMs: 1800000010000})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{start, firstAnchor, transition, secondAnchor}); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		_ = lease.Close()

		t.Fatal(err)
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	clock := &fakeClock{boot: boot, elapsed: 180000, wall: 1800000000000}
	pipeline, err := NewPipeline(DefaultPolicy(), clock, nil, provider,
		map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithWaitUntil(func(context.Context, int64) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}

	if err := pipeline.recoverBootStart(context.Background()); err != nil {
		t.Fatal(err)
	}

	view := pipeline.tracker.View()

	if view.State != telemetryclock.Anchored || view.Segment != 0 || view.Anchor == nil ||
		view.Anchor.UTCMs != 1800000000000 {
		t.Fatalf("recovery selected noncanonical anchor: %+v", view)
	}
}

func TestPipelineStopDrainsQueue(t *testing.T) {
	dir := t.TempDir()
	paths, err := journal.PathsFromRRDDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	provider, err := journal.NewStorageProvider(paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provider.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer func() { _ = provider.Close(context.Background()) }()

	clock := &fakeClock{boot: journal.BootID{1}, elapsed: 180000, wall: 1800000000000}
	pipeline, err := NewPipeline(DefaultPolicy(), clock, nil, provider, map[uint16]Sampler{1: &recordingSampler{values: []Value{{Known: true, V: 1}}}},
		WithWaitUntil(func(context.Context, int64) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}

	pipeline.acquire(context.Background(), telemetryclock.Reading{Boot: clock.boot, ElapsedMs: 180000})

	if pipeline.Status().PendingSamples == 0 {
		t.Fatal("nothing queued")
	}

	if err := pipeline.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	if remaining := pipeline.Status().PendingSamples; remaining != 0 {
		t.Fatalf("shutdown left %d records queued", remaining)
	}

	if errors.Is(context.Canceled, nil) {
		t.Fatal("unreachable")
	}
}
