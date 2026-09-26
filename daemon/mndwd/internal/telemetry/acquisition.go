package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
	"mndwd/internal/telemetry/publication"
)

// Sampler polls one series. Failure yields unknown values, never a synthetic
// measurement.
type Sampler interface {
	Poll(context.Context) ([]rrd.Value, error)
}

// PublicationWorker delivers derived output. The pipeline calls Recover before
// the first RunCycle and after every successful reattachment.
type PublicationWorker interface {
	Recover(context.Context) error
	RunCycle(context.Context, publication.Cycle) error
	CloseClean(context.Context) error
}

// SnapshotRefresher republishes cached chart data after delivery or clock
// changes. HTTP handlers never call it.
type SnapshotRefresher interface {
	Refresh(context.Context, PipelineStatus) error
	Close(context.Context) error
}

// PipelineStatus is an immutable snapshot of acquisition and storage state.
type PipelineStatus struct {
	Storage         journal.RecoveryStatus
	Clock           clock.View
	DurableThrough  uint64
	PendingSamples  int
	PendingBytes    int
	SupportedSeries map[uint16]bool
	Frontiers       map[uint16]int64
	Coverage        []journal.Coverage
	RebuildState    string
	Loss            map[string]uint64
	Error           string
}

// Pipeline is the single coordinator owning acquisition, clock evidence,
// journal durability, and publication scheduling.
type Pipeline struct {
	policy   Policy
	clock    clock.BootClock
	evidence clock.EvidenceSource
	storage  journal.StorageProvider
	samplers map[uint16]Sampler
	logger   *slog.Logger

	waitUntil   func(context.Context, int64) error
	publication PublicationWorker
	refresher   SnapshotRefresher

	mu              sync.Mutex
	flushMu         sync.Mutex
	tracker         *clock.Tracker
	queue           []journal.Record
	queueBytes      int
	loss            map[journal.LossReason]uint64
	status          PipelineStatus
	origin          int64
	bootStartQueued bool
	firstUnsynced   int64
	lastSync        time.Time
	publicationBus  chan publication.Cycle
	lastSlot        map[int64]int64
	runCancel       context.CancelFunc
	runDone         chan struct{}
	stopChan        chan struct{}
	stopOnce        sync.Once
	stopped         bool
}

// PipelineOption customizes a pipeline.
type PipelineOption func(*Pipeline)

func clockPolicy(policy Policy) clock.Policy {
	return clock.Policy{
		JumpThreshold:      policy.JumpThreshold,
		MaxObservationSpan: policy.MaxObservationSpan,
	}
}

// WithWaitUntil injects the elapsed-time scheduler used by tests.
func WithWaitUntil(wait func(context.Context, int64) error) PipelineOption {
	return func(p *Pipeline) {
		if wait != nil {
			p.waitUntil = wait
		}
	}
}

// WithPublicationWorker attaches derived delivery. Without it the pipeline only
// journals, which is not a releasable configuration.
func WithPublicationWorker(worker PublicationWorker) PipelineOption {
	return func(p *Pipeline) { p.publication = worker }
}

// WithSnapshotRefresher attaches background chart refresh ownership.
func WithSnapshotRefresher(refresher SnapshotRefresher) PipelineOption {
	return func(p *Pipeline) { p.refresher = refresher }
}

// NewPipeline builds the telemetry coordinator.
func NewPipeline(
	policy Policy,
	bootClock clock.BootClock,
	evidence clock.EvidenceSource,
	storage journal.StorageProvider,
	samplers map[uint16]Sampler,
	opts ...PipelineOption,
) (*Pipeline, error) {
	if err := ValidatePolicy(policy); err != nil {
		return nil, err
	}

	if bootClock == nil {
		return nil, errors.New("telemetry: boot clock is required")
	}

	if storage == nil {
		return nil, errors.New("telemetry: storage provider is required")
	}

	if len(samplers) == 0 {
		return nil, errors.New("telemetry: at least one sampler is required")
	}

	initialDurable := uint64(0)

	if lease, err := storage.Acquire(context.Background()); err == nil {
		if lease.Result.Writer != nil {
			initialDurable = lease.Result.Writer.DurableThrough()
		}

		_ = lease.Close()
	}

	pipeline := &Pipeline{
		policy:         policy,
		clock:          bootClock,
		evidence:       evidence,
		storage:        storage,
		samplers:       samplers,
		logger:         slog.Default(),
		tracker:        clock.NewTracker(clock.View{State: clock.Unanchored}, clockPolicy(policy)),
		loss:           map[journal.LossReason]uint64{},
		lastSlot:       map[int64]int64{},
		stopChan:       make(chan struct{}),
		publicationBus: make(chan publication.Cycle, 1),
		status:         PipelineStatus{Storage: storage.CurrentStatus(), DurableThrough: initialDurable, SupportedSeries: supportedFromSamplers(samplers), Loss: map[string]uint64{}},
	}

	if pipeline.waitUntil == nil {
		pipeline.waitUntil = defaultWaitUntil(bootClock, policy)
	}

	for _, opt := range opts {
		opt(pipeline)
	}

	return pipeline, nil
}

// maxWaitSlice bounds one wait so shutdown and clock steps stay responsive.
const maxWaitSlice = time.Second

// defaultWaitUntil sleeps until the boot-relative deadline, re-reading the
// clock so a clock step cannot extend the wait indefinitely.
func defaultWaitUntil(clock clock.BootClock, _ Policy) func(context.Context, int64) error {
	return func(ctx context.Context, deadlineMs int64) error {
		for {
			reading, err := clock.Read()
			if err != nil {
				return err
			}

			remaining := deadlineMs - reading.ElapsedMs

			if remaining <= 0 {
				return nil
			}

			delay := time.Duration(remaining) * time.Millisecond

			if delay > maxWaitSlice {
				delay = maxWaitSlice
			}

			timer := time.NewTimer(delay)

			select {
			case <-ctx.Done():
				timer.Stop()

				return ctx.Err()
			case <-timer.C:
			}
		}
	}
}

func supportedFromSamplers(samplers map[uint16]Sampler) map[uint16]bool {
	m := make(map[uint16]bool, len(samplers))

	for series, sampler := range samplers {
		m[series] = sampler != nil

		if probe, ok := sampler.(interface{ Supported() bool }); ok {
			m[series] = probe.Supported()
		}
	}

	return m
}

// Status returns an immutable pipeline snapshot.
func (p *Pipeline) Status() PipelineStatus {
	p.mu.Lock()

	defer p.mu.Unlock()

	status := p.status
	status.PendingSamples = len(p.queue)
	status.PendingBytes = p.queueBytes
	status.Clock = p.tracker.View()
	status.Storage = p.storage.CurrentStatus()
	status.Loss = map[string]uint64{}

	for reason, count := range p.loss {
		status.Loss[fmt.Sprintf("%d", reason)] = count
	}

	return status
}

// Run owns the acquisition, evidence, and publication schedules until ctx ends.
func (p *Pipeline) Run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	p.mu.Lock()

	p.runCancel = cancel
	p.runDone = done

	p.mu.Unlock()

	// Stop may be called before the loop reaches a wait, so cancel on the stop
	// signal as well as on context completion.
	go func() {
		select {
		case <-p.stopChan:
			cancel()
		case <-runCtx.Done():
		}
	}()

	defer func() {
		cancel()
		close(done)
	}()

	if err := p.recoverBootStart(runCtx); err != nil {
		p.logger.Warn("telemetry: boot start recovery incomplete", "error", err)
	}

	// Establish the acquisition origin when this boot has none so the first
	// sample lands on a scheduled deadline rather than at process start.
	reading, readErr := p.clock.Read()

	if readErr == nil {
		p.mu.Lock()

		if p.origin == 0 {
			p.origin = nextDeadlineAfter(reading.ElapsedMs, p.policy.AcquireEvery.Milliseconds(), reading.ElapsedMs)
		}

		p.mu.Unlock()
	}

	publicationDone := make(chan struct{})

	if p.publication != nil {
		if err := p.publication.Recover(runCtx); err != nil {
			p.mu.Lock()

			p.status.RebuildState = "unavailable"
			p.status.Error = err.Error()

			p.mu.Unlock()
			p.logger.Warn("telemetry: derived recovery failed", "error", err)
		}
	}

	go p.runPublication(runCtx, publicationDone)

	var runErr error

	for {
		if err := runCtx.Err(); err != nil {
			runErr = err

			break
		}

		deadline, err := p.nextDeadline(runCtx)
		if err != nil {
			runErr = err

			break
		}

		if err := p.waitUntil(runCtx, deadline); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				break
			}

			runErr = err

			break
		}

		p.runDueWork(runCtx)
	}

	close(p.publicationBus)
	<-publicationDone

	return runErr
}

// runDueWork performs one scheduler tick: evidence when due, acquisition when
// due, and journal durability whenever the sync deadline elapsed.
func (p *Pipeline) runDueWork(ctx context.Context) {
	reading, err := p.clock.Read()
	if err != nil {
		p.mu.Lock()

		p.status.Error = err.Error()

		p.mu.Unlock()

		return
	}

	if p.due(reading.ElapsedMs, p.policy.EvidenceEvery) {
		p.pollEvidence(ctx, reading)
	}

	if p.due(reading.ElapsedMs, p.policy.AcquireEvery) {
		p.acquire(ctx, reading)
	}

	publishDue := p.due(reading.ElapsedMs, p.policy.PublishEvery)

	if err := p.flush(ctx, reading); err != nil {
		p.logger.Warn("telemetry: journal flush failed", "error", err)
	}

	if publishDue {
		p.maintain(ctx, reading)
		p.schedulePublication(reading)
	}
}

// due reports whether the slot for this period has not run yet. Slots, not
// wall time, decide work: a missed poll stays a gap.
func (p *Pipeline) due(elapsed int64, period time.Duration) bool {
	p.mu.Lock()

	defer p.mu.Unlock()

	if p.origin == 0 || elapsed < p.origin || period <= 0 {
		return false
	}

	slot := (elapsed - p.origin) / period.Milliseconds()
	key := period.Milliseconds()

	if previous, ok := p.lastSlot[key]; ok && previous >= slot {
		return false
	}

	p.lastSlot[key] = slot

	return true
}

func (p *Pipeline) nextDeadline(ctx context.Context) (int64, error) {
	reading, err := p.clock.Read()
	if err != nil {
		return 0, err
	}

	if p.origin == 0 {
		return reading.ElapsedMs, nil
	}

	period := p.policy.EvidenceEvery
	deadline := nextDeadlineAfter(p.origin, period.Milliseconds(), reading.ElapsedMs)

	for _, candidate := range []time.Duration{p.policy.AcquireEvery, p.policy.PublishEvery} {
		next := nextDeadlineAfter(p.origin, candidate.Milliseconds(), reading.ElapsedMs)

		if next < deadline {
			deadline = next
		}
	}

	if p.firstUnsynced > 0 {
		syncDeadline := SyncDeadline(p.firstUnsynced, p.policy.MaxUnsynced)

		if syncDeadline < deadline {
			deadline = syncDeadline
		}
	}

	if err := ctx.Err(); err != nil {
		return 0, err
	}

	return deadline, nil
}

// recoverBootStart restores the persisted acquisition origin so a restart does
// not establish a fresh schedule from process start time.
func (p *Pipeline) recoverBootStart(ctx context.Context) error {
	lease, err := p.storage.Acquire(ctx)
	if err != nil {
		return err
	}

	defer func() { _ = lease.Close() }()

	boot, err := p.currentBoot()
	if err != nil {
		return err
	}

	var origin int64
	var sequence uint64
	anchors := map[uint64]journal.Anchor{}
	var latestTransition journal.ClockTransition
	var transitionSequence uint64

	if lease.Result.Reader != nil {
		_ = lease.Result.Reader.Scan(ctx, func(record journal.Record) error {
			switch record.Kind {
			case journal.KindBootStart:
				start, err := journal.DecodeBootStart(record)
				if err == nil && start.Boot == boot && start.Seq >= sequence {
					sequence = start.Seq
					origin = start.FirstAcquireElapsedMs
				}
			case journal.KindAnchor:
				anchor, err := journal.DecodeAnchor(record)
				if err == nil && anchor.Boot == boot {
					if current, ok := anchors[anchor.ClockSegment]; !ok || anchor.Seq >= current.Seq {
						anchors[anchor.ClockSegment] = anchor
					}
				}
			case journal.KindClockTransition:
				transition, err := journal.DecodeClockTransition(record)
				if err == nil && transition.Boot == boot && transition.Seq >= transitionSequence {
					latestTransition = transition
					transitionSequence = transition.Seq
				}
			}

			return nil
		})
	}

	p.mu.Lock()

	defer p.mu.Unlock()

	view := clock.View{State: clock.Unanchored, Boot: boot}

	if transitionSequence > 0 {
		view.Segment = latestTransition.ClockSegment
		view.ConsumedEvidenceID = latestTransition.ConsumedEvidenceID

		switch latestTransition.State {
		case journal.StateAnchored:
			view.State = clock.Anchored
		case journal.StateSuspect:
			view.State = clock.Suspect
			view.SuspectElapsedMs = latestTransition.SuspectElapsedMs
		}

		if anchor, ok := anchors[view.Segment]; ok {
			copy := anchor
			view.Anchor = &copy
		}
	} else {
		for segment, anchor := range anchors {
			if segment >= view.Segment {
				copy := anchor
				view.Segment = segment
				view.Anchor = &copy
				view.State = clock.Anchored
			}
		}
	}

	p.tracker = clock.NewTracker(view, clockPolicy(p.policy))

	if origin > 0 {
		p.origin = origin
		p.bootStartQueued = true
		_ = sequence
	}

	return nil
}

func (p *Pipeline) currentBoot() (journal.BootID, error) {
	reading, err := p.clock.Read()
	if err != nil {
		return journal.BootID{}, err
	}

	return reading.Boot, nil
}

// pollEvidence performs one bracketed observation and durably installs any
// proposed change.
func (p *Pipeline) pollEvidence(ctx context.Context, reading clock.Reading) {
	if p.evidence == nil {
		return
	}

	p.mu.Lock()

	view := p.tracker.View()
	request := clock.EvidenceRequest{Boot: reading.Boot, SuspectElapsedMs: view.SuspectElapsedMs, ConsumedEvidenceID: view.ConsumedEvidenceID}

	p.mu.Unlock()

	before, after, evidence, err := clock.ReadEvidence(ctx, p.clock, p.evidence, request)
	if err != nil {
		p.logger.Debug("telemetry: clock evidence unavailable", "error", err)

		return
	}

	p.mu.Lock()

	proposed, records, err := p.tracker.Observe(before, after, evidence)
	if err != nil || len(records) == 0 {
		p.mu.Unlock()

		return
	}

	p.mu.Unlock()

	p.enqueue(records, reading.ElapsedMs)

	if err := p.flush(ctx, reading); err != nil {
		p.logger.Warn("telemetry: clock evidence not durable", "error", err)

		return
	}

	if err := p.syncNow(ctx); err != nil {
		p.logger.Warn("telemetry: clock evidence not durable", "error", err)

		return
	}

	p.mu.Lock()
	p.tracker.Install(proposed)
	p.mu.Unlock()
}

// acquire polls every sampler and queues one sample per series.
func (p *Pipeline) acquire(ctx context.Context, reading clock.Reading) {
	p.mu.Lock()

	view, transitions, err := p.tracker.Check(reading)
	state := view

	p.mu.Unlock()

	if err == nil && len(transitions) > 0 {
		p.enqueue(transitions, reading.ElapsedMs)

		if flushErr := p.flush(ctx, reading); flushErr == nil {
			if syncErr := p.syncNow(ctx); syncErr == nil {
				p.mu.Lock()
				p.tracker.Install(view)
				p.mu.Unlock()
			} else {
				p.logger.Warn("telemetry: clock transition not durable", "error", syncErr)
			}
		} else {
			p.logger.Warn("telemetry: clock transition append failed", "error", flushErr)
		}
	}

	p.mu.Lock()

	needBootStart := !p.bootStartQueued
	origin := p.origin

	p.mu.Unlock()

	if needBootStart {
		if origin == 0 {
			origin = nextDeadlineAfter(reading.ElapsedMs, p.policy.AcquireEvery.Milliseconds(), reading.ElapsedMs)
		}

		prepared, err := journal.PrepareBootStart(journal.BootStart{Boot: reading.Boot, FirstAcquireElapsedMs: origin})
		if err == nil {
			p.enqueue([]journal.Record{prepared}, reading.ElapsedMs)
			p.mu.Lock()

			p.origin = origin
			p.bootStartQueued = true

			p.mu.Unlock()

			if err := p.flush(ctx, reading); err != nil {
				p.logger.Warn("telemetry: boot start not durable", "error", err)
			} else if err := p.syncNow(ctx); err != nil {
				p.logger.Warn("telemetry: boot start not durable", "error", err)
			}
		}
	}

	for series, sampler := range p.samplers {
		values, err := sampler.Poll(ctx)
		journalValues := make([]journal.Value, 0, len(values))

		if err != nil {
			// A failed poll is an unknown value, never a measurement.
			for range values {
				journalValues = append(journalValues, journal.Value{Known: false})
			}

			if len(values) == 0 {
				journalValues = append(journalValues, journal.Value{Known: false})
			}
		} else {
			for _, value := range values {
				journalValues = append(journalValues, journal.Value{Known: value.Known, V: value.V})
			}
		}

		sample := journal.Sample{
			Boot:         reading.Boot,
			ClockSegment: state.Segment,
			Series:       series,
			ElapsedMs:    reading.ElapsedMs,
			Values:       journalValues,
		}
		prepared, err := journal.PrepareSample(sample)
		if err != nil {
			p.logger.Warn("telemetry: sample rejected", "series", series, "error", err)

			continue
		}

		p.enqueue([]journal.Record{prepared}, reading.ElapsedMs)
	}
}

// enqueue admits prepared records, dropping the oldest queued samples when the
// bounded RAM queue is full.
func (p *Pipeline) enqueue(records []journal.Record, elapsedMs int64) {
	p.mu.Lock()

	defer p.mu.Unlock()

	for _, record := range records {
		size := len(record.Payload) + 16

		for p.queueBytes+size > p.policy.QueueBytes && len(p.queue) > 0 {
			dropped := p.queue[0]
			p.queue = p.queue[1:]
			p.queueBytes -= len(dropped.Payload) + 16
			p.loss[journal.LossQueueOverflow]++
		}

		if p.queueBytes+size > p.policy.QueueBytes {
			p.loss[journal.LossQueueOverflow]++

			continue
		}

		p.queue = append(p.queue, record)
		p.queueBytes += size
	}

	if p.firstUnsynced == 0 {
		p.firstUnsynced = elapsedMs
	}
}

// flush appends queued records and synchronizes when the durability deadline
// elapsed.
func (p *Pipeline) flush(ctx context.Context, reading clock.Reading) error {
	p.flushMu.Lock()

	defer p.flushMu.Unlock()

	p.mu.Lock()

	records := append([]journal.Record(nil), p.queue...)
	due := p.firstUnsynced > 0 && reading.ElapsedMs >= SyncDeadline(p.firstUnsynced, p.policy.MaxUnsynced)

	p.mu.Unlock()

	if len(records) == 0 && !due {
		return nil
	}

	lease, err := p.storage.Acquire(ctx)
	if err != nil {
		return err
	}

	defer func() { _ = lease.Close() }()

	if lease.Result.Writer == nil {
		// Read-only or unavailable storage keeps bounded RAM retention only.
		p.mu.Lock()

		p.status.Error = "storage " + string(lease.Result.Status.Mode)

		p.mu.Unlock()

		return nil
	}

	appended, err := lease.Result.Writer.Append(ctx, records)

	if appended.Accepted > 0 {
		p.mu.Lock()

		p.queue = p.queue[appended.Accepted:]
		p.queueBytes = 0

		for _, record := range p.queue {
			p.queueBytes += len(record.Payload) + 16
		}

		if p.firstUnsynced == 0 {
			p.firstUnsynced = reading.ElapsedMs
		}

		p.mu.Unlock()
	}

	if err != nil {
		p.logger.Warn("telemetry: append incomplete", "accepted", appended.Accepted, "error", err)

		if appended.NeedsRepair {
			if repairErr := lease.Result.Writer.RepairTail(ctx); repairErr != nil {
				return repairErr
			}
		}

		return err
	}

	p.mu.Lock()

	due = p.firstUnsynced > 0 && reading.ElapsedMs >= SyncDeadline(p.firstUnsynced, p.policy.MaxUnsynced)

	p.mu.Unlock()

	if !due {
		return nil
	}

	durable, err := lease.Result.Writer.Sync(ctx)
	if err != nil {
		return err
	}

	p.mu.Lock()

	p.firstUnsynced = 0
	p.status.DurableThrough = durable
	p.lastSync = time.Now()

	p.mu.Unlock()

	return nil
}

// syncNow forces the current journal high-water mark durable. It is used for
// clock transitions and anchors whose state must not become visible first.
func (p *Pipeline) syncNow(ctx context.Context) error {
	lease, err := p.storage.Acquire(ctx)
	if err != nil {
		return err
	}

	defer func() { _ = lease.Close() }()

	if lease.Result.Writer == nil {
		return errors.New("telemetry: journal writer unavailable")
	}

	durable, err := lease.Result.Writer.Sync(ctx)
	if err != nil {
		return err
	}

	p.mu.Lock()

	p.firstUnsynced = 0
	p.status.DurableThrough = durable
	p.lastSync = time.Now()

	p.mu.Unlock()

	return nil
}

func (p *Pipeline) maintain(ctx context.Context, reading clock.Reading) {
	lease, err := p.storage.Acquire(ctx)
	if err != nil || lease.Result.Writer == nil {
		if err == nil {
			_ = lease.Close()
		}

		return
	}

	defer func() { _ = lease.Close() }()

	input := journal.RetentionInput{LatestElapsed: map[journal.BootID]int64{reading.Boot: reading.ElapsedMs}}

	p.mu.Lock()

	if p.tracker.View().State == clock.Anchored {
		now := reading.WallMs
		input.TrustedNowMs = &now
	}

	p.mu.Unlock()

	if err := lease.Result.Writer.Maintain(ctx, input); err != nil {
		p.logger.Warn("telemetry: retention maintenance failed", "error", err)
	}
}

// schedulePublication hands one cycle to the publication worker.
func (p *Pipeline) schedulePublication(reading clock.Reading) {
	p.mu.Lock()

	cycle := publication.Cycle{CutoffElapsedMs: reading.ElapsedMs, DurableThrough: p.status.DurableThrough, Clock: p.tracker.View()}

	p.mu.Unlock()

	select {
	case p.publicationBus <- cycle:
	default:
	}
}

// runPublication serializes derived delivery and refreshes cached snapshots.
func (p *Pipeline) runPublication(ctx context.Context, done chan struct{}) {
	defer close(done)

	for cycle := range p.publicationBus {
		if ctx.Err() != nil {
			return
		}

		if p.publication == nil {
			continue
		}

		if err := p.publication.RunCycle(ctx, cycle); err != nil {
			p.mu.Lock()

			p.status.Error = err.Error()

			p.mu.Unlock()
			p.logger.Warn("telemetry: publication cycle failed", "error", err)
		}

		if p.refresher != nil {
			if err := p.refresher.Refresh(ctx, p.Status()); err != nil {
				p.logger.Warn("telemetry: snapshot refresh failed", "error", err)
			}
		}
	}
}

// Stop joins acquisition, drains queued records, and closes derived state.
func (p *Pipeline) Stop(ctx context.Context) error {
	p.mu.Lock()

	p.stopped = true
	cancel := p.runCancel
	done := p.runDone

	p.mu.Unlock()

	p.stopOnce.Do(func() { close(p.stopChan) })

	if cancel != nil {
		cancel()
	}

	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	reading, err := p.clock.Read()
	if err == nil {
		if flushErr := p.flush(ctx, reading); flushErr != nil {
			p.logger.Warn("telemetry: shutdown flush failed", "error", flushErr)
		}
	}

	if p.refresher != nil {
		if err := p.refresher.Close(ctx); err != nil {
			p.logger.Warn("telemetry: refresher close failed", "error", err)
		}
	}

	if p.publication != nil {
		return p.publication.CloseClean(ctx)
	}

	return nil
}
