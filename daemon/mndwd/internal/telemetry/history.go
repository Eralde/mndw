package telemetry

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"mndwd/internal/telemetry/journal"
)

// HistoryReader scans the validated journal inventory.
type HistoryReader interface {
	Scan(context.Context, func(journal.Record) error) error
	ScanAfter(context.Context, uint64, uint64, func(journal.Record) error) error
}

// History owns the bounded raw projection of the authoritative journal.
// Published stores are replaced only after a complete successful reduction.
type History struct {
	limits journal.Limits
	specs  []SeriesSpec
	reduce *Reducer

	opMu sync.Mutex
	mu   sync.RWMutex

	store          *RawStore
	appliedThrough uint64
	controls       []journal.Record
	pending        map[journal.SegmentKey]struct{}
}

// NewHistory builds an empty raw projection with capacity derived from journal
// retention.
func NewHistory(limits journal.Limits, specs []SeriesSpec) (*History, error) {
	store, err := NewRawStore(limits, specs)
	if err != nil {
		return nil, err
	}

	reducer, err := NewReducer(limits, specs)
	if err != nil {
		return nil, err
	}

	return &History{
		limits:  limits,
		specs:   cloneSeriesSpecs(specs),
		reduce:  reducer,
		store:   store,
		pending: make(map[journal.SegmentKey]struct{}),
	}, nil
}

// restore synchronizes and replays a writable journal, replays validated
// read-only records without mutation, or publishes empty history when storage
// is unavailable.
func (h *History) restore(
	ctx context.Context,
	mode journal.StatusMode,
	reader HistoryReader,
	writer HistoryWriter,
	input journal.RetentionInput,
) error {
	h.opMu.Lock()

	defer h.opMu.Unlock()

	if mode == journal.StatusUnavailable {
		empty, err := NewRawStore(h.limits, h.specs)
		if err != nil {
			return err
		}

		h.mu.Lock()

		h.store = empty
		h.appliedThrough = 0
		h.controls = nil
		h.pending = make(map[journal.SegmentKey]struct{})

		h.mu.Unlock()

		return nil
	}

	if reader == nil {
		return errors.New("telemetry: history reader is required")
	}

	var through uint64
	var pin *journal.Lease

	if mode == journal.StatusReady {
		if writer == nil {
			return errors.New("telemetry: writable history requires journal writer")
		}

		var err error
		through, err = writer.Sync(ctx)
		if err != nil {
			return fmt.Errorf("telemetry: sync startup journal: %w", err)
		}

		pin, err = writer.Pin(through)
		if err != nil {
			return fmt.Errorf("telemetry: pin startup journal: %w", err)
		}

		defer func() { _ = pin.Close() }()
	} else if mode != journal.StatusReadOnly {
		return fmt.Errorf("telemetry: unsupported history mode %q", mode)
	}

	records := make([]journal.Record, 0)
	validatedEnd := uint64(0)

	if err := reader.Scan(ctx, func(record journal.Record) error {
		if mode == journal.StatusReady && record.Seq > through {
			return nil
		}

		if record.Seq > validatedEnd {
			validatedEnd = record.Seq
		}

		records = append(records, cloneJournalRecord(record))

		return nil
	}); err != nil {
		return fmt.Errorf("telemetry: scan startup journal: %w", err)
	}

	if mode == journal.StatusReadOnly {
		through = validatedEnd
	}

	result, err := h.reduce.Reduce(records, through, input)
	if err != nil {
		return err
	}

	next, err := NewRawStore(h.limits, h.specs)
	if err != nil {
		return err
	}

	if err := next.Apply(result.Batch); err != nil {
		return err
	}

	controls := make([]journal.Record, 0)

	for _, record := range records {
		if isHistoryControl(record.Kind) {
			controls = append(controls, record)
		}
	}

	h.mu.Lock()

	h.store = next
	h.appliedThrough = through
	h.controls = controls
	h.pending = clonePending(result.PendingSegments)

	h.mu.Unlock()

	return nil
}

// applyDurable reduces records through the writer's synchronized high-water
// mark. The caller syncs appended data before invoking this method.
func (h *History) applyDurable(
	ctx context.Context,
	reader HistoryReader,
	writer HistoryWriter,
	input journal.RetentionInput,
) error {
	h.opMu.Lock()

	defer h.opMu.Unlock()

	if reader == nil || writer == nil {
		return errors.New("telemetry: live history requires reader and writer")
	}

	through := writer.DurableThrough()

	h.mu.RLock()

	applied := h.appliedThrough
	store := h.store
	controls := append([]journal.Record(nil), h.controls...)
	pending := clonePending(h.pending)

	h.mu.RUnlock()

	if through <= applied {
		return nil
	}

	pin, err := writer.Pin(through)
	if err != nil {
		return fmt.Errorf("telemetry: pin live journal: %w", err)
	}

	defer func() { _ = pin.Close() }()

	records := append([]journal.Record(nil), controls...)
	newControls := make([]journal.Record, 0)

	if err := reader.ScanAfter(ctx, applied, through, func(record journal.Record) error {
		if record.Seq <= applied || record.Seq > through {
			return nil
		}

		copy := cloneJournalRecord(record)
		records = append(records, copy)

		if isHistoryControl(record.Kind) {
			newControls = append(newControls, copy)
		}

		return nil
	}); err != nil {
		return fmt.Errorf("telemetry: scan live journal: %w", err)
	}

	allControls := append(append([]journal.Record(nil), controls...), newControls...)
	anchorIndex := journal.BuildAnchorIndex(allControls)
	replayCandidates := make(map[journal.SegmentKey]struct{})

	for key := range pending {
		if anchorIndex.HasAnchor(key) || (key.ClockSegment == 0 && anchorIndex.CanMapLegacySegmentZero(key.Boot)) {
			replayCandidates[key] = struct{}{}
		}
	}

	if len(replayCandidates) > 0 {
		if err := reader.Scan(ctx, func(record journal.Record) error {
			if record.Kind != journal.KindSample || record.Seq > applied || record.Seq > through {
				return nil
			}

			sample, err := journal.DecodeSample(record)
			if err != nil {
				return nil
			}

			key := journal.SegmentKey{Boot: sample.Boot, ClockSegment: sample.ClockSegment}

			if _, ok := replayCandidates[key]; ok {
				records = append(records, cloneJournalRecord(record))
			}

			return nil
		}); err != nil {
			return fmt.Errorf("telemetry: replay pending journal samples: %w", err)
		}
	}

	result, err := h.reduce.Reduce(records, through, input)
	if err != nil {
		return err
	}

	if err := store.Apply(result.Batch); err != nil {
		return err
	}

	for key := range result.PendingSegments {
		pending[key] = struct{}{}
	}

	for _, key := range result.ReplayRequests {
		if _, unresolved := result.PendingSegments[key]; !unresolved {
			delete(pending, key)
		}
	}

	for key := range replayCandidates {
		if _, unresolved := result.PendingSegments[key]; !unresolved {
			delete(pending, key)
		}
	}

	h.mu.Lock()

	h.appliedThrough = through
	h.controls = append(controls, newControls...)
	h.pending = pending

	h.mu.Unlock()

	return nil
}

// AppliedThrough reports the last sequence successfully reflected in raw
// history.
func (h *History) AppliedThrough() uint64 {
	h.mu.RLock()

	defer h.mu.RUnlock()

	return h.appliedThrough
}

// Read returns chronological raw rows from the current immutable store view.
func (h *History) Read(query Query) ([]Row, error) {
	h.mu.RLock()

	store := h.store

	h.mu.RUnlock()

	return store.Read(query)
}

// ReadMany returns copied rows from one store generation.
func (h *History) ReadMany(queries []Query) ([][]Row, error) {
	h.mu.RLock()

	store := h.store

	h.mu.RUnlock()

	return store.ReadMany(queries)
}

// SeriesSpecs returns an independent copy of the configured raw series.
func (h *History) SeriesSpecs() []SeriesSpec {
	return cloneSeriesSpecs(h.specs)
}

// Bounds returns the retained raw slot bounds for one series.
func (h *History) Bounds(series uint16) (from, to time.Time, ok bool) {
	h.mu.RLock()

	store := h.store

	h.mu.RUnlock()

	return store.Bounds(series)
}

// HistoryWriter is the writable subset required to establish durability and
// protect scans from maintenance.
type HistoryWriter interface {
	Sync(context.Context) (uint64, error)
	DurableThrough() uint64
	Pin(uint64) (*journal.Lease, error)
}

func isHistoryControl(kind journal.Kind) bool {
	return kind == journal.KindAnchor || kind == journal.KindClockTransition || kind == journal.KindBootStart
}

func clonePending(pending map[journal.SegmentKey]struct{}) map[journal.SegmentKey]struct{} {
	clone := make(map[journal.SegmentKey]struct{}, len(pending))

	for key := range pending {
		clone[key] = struct{}{}
	}

	return clone
}

func cloneSeriesSpecs(specs []SeriesSpec) []SeriesSpec {
	clone := make([]SeriesSpec, len(specs))

	for index, spec := range specs {
		clone[index] = spec
		clone[index].ValueKeys = append([]string(nil), spec.ValueKeys...)
	}

	return clone
}

func cloneJournalRecord(record journal.Record) journal.Record {
	record.Payload = append([]byte(nil), record.Payload...)

	return record
}
