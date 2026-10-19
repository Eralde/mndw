package telemetry

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"mndwd/internal/telemetry/journal"
)

// ReduceResult is a deterministic projection through one durable sequence.
// PendingSegments contains identities only; samples remain in the journal.
type ReduceResult struct {
	Through         uint64
	Batch           Batch
	PendingSegments map[journal.SegmentKey]struct{}
	ReplayRequests  []journal.SegmentKey
}

// Reducer maps durable samples into telemetry-owned raw slots.
type Reducer struct {
	retention time.Duration
	specs     map[uint16]SeriesSpec
}

// NewReducer builds a deterministic journal-to-raw reducer.
func NewReducer(limits journal.Limits, specs []SeriesSpec) (*Reducer, error) {
	if limits.Retention <= 0 {
		return nil, errors.New("telemetry: journal retention must be positive")
	}

	if len(specs) == 0 {
		return nil, errors.New("telemetry: at least one series spec is required")
	}

	reducer := &Reducer{retention: limits.Retention, specs: make(map[uint16]SeriesSpec, len(specs))}

	for _, spec := range specs {
		if spec.ID == 0 || spec.Step <= 0 || spec.Step%time.Millisecond != 0 || len(spec.ValueKeys) == 0 {
			return nil, fmt.Errorf("telemetry: invalid series spec %d", spec.ID)
		}

		if _, exists := reducer.specs[spec.ID]; exists {
			return nil, fmt.Errorf("telemetry: duplicate series spec %d", spec.ID)
		}

		for _, key := range spec.ValueKeys {
			if key == "" {
				return nil, fmt.Errorf("telemetry: empty value key for series %d", spec.ID)
			}
		}

		spec.ValueKeys = append([]string(nil), spec.ValueKeys...)
		reducer.specs[spec.ID] = spec
	}

	return reducer, nil
}

// Reduce reads records only through durableThrough, maps all samples with the
// canonical anchor index, and returns one whole-vector winner per UTC slot.
func (r *Reducer) Reduce(records []journal.Record, durableThrough uint64, input journal.RetentionInput) (ReduceResult, error) {
	selected := make([]journal.Record, 0, len(records))

	for _, record := range records {
		if record.Seq <= durableThrough {
			selected = append(selected, record)
		}
	}

	sort.SliceStable(selected, func(left, right int) bool {
		return selected[left].Seq < selected[right].Seq
	})

	anchors := journal.BuildAnchorIndex(selected)
	result := ReduceResult{
		Through:         durableThrough,
		PendingSegments: make(map[journal.SegmentKey]struct{}),
	}
	winners := make(map[rawSlotKey]SlotUpdate)
	awaitingReplay := make(map[journal.SegmentKey]uint64)
	replayRequests := make(map[journal.SegmentKey]struct{})

	for _, record := range selected {
		if record.Kind == journal.KindAnchor {
			anchor, err := journal.DecodeAnchor(record)
			if err == nil {
				for key, closesAt := range awaitingReplay {
					if closesAt == anchor.Seq {
						replayRequests[key] = struct{}{}

						delete(awaitingReplay, key)
					}
				}
			}
		}

		if record.Kind != journal.KindSample {
			continue
		}

		sample, err := journal.DecodeSample(record)
		if err != nil {
			return ReduceResult{}, fmt.Errorf("telemetry: decode sample sequence %d: %w", record.Seq, err)
		}

		spec, knownSeries := r.specs[sample.Series]

		if !knownSeries {
			continue
		}

		if len(sample.Values) != len(spec.ValueKeys) {
			return ReduceResult{}, fmt.Errorf("telemetry: sample sequence %d has %d values for series %d, want %d", sample.Seq, len(sample.Values), sample.Series, len(spec.ValueKeys))
		}

		anchor, ok := anchors.AnchorFor(sample)
		key := journal.SegmentKey{Boot: sample.Boot, ClockSegment: sample.ClockSegment}

		if !ok {
			result.PendingSegments[key] = struct{}{}

			continue
		}

		if anchor.Seq > sample.Seq {
			awaitingReplay[key] = anchor.Seq
		}

		mappedUTC, err := journal.MapUTC(anchor, sample.ElapsedMs)
		if err != nil {
			continue
		}

		if journal.SampleExpired(sample, &mappedUTC, input, r.retention) {
			continue
		}

		slotMs := floorSlotMillis(mappedUTC, spec.Step.Milliseconds())
		row := Row{Slot: time.UnixMilli(slotMs).UTC(), Sequence: sample.Seq, Values: make([]Value, len(sample.Values))}

		for index, value := range sample.Values {
			if value.Known && !math.IsNaN(value.V) && !math.IsInf(value.V, 0) {
				row.Values[index] = Value{V: value.V, Known: true}
			}
		}

		slotKey := rawSlotKey{series: sample.Series, slotMs: slotMs}

		if winner, exists := winners[slotKey]; !exists || sample.Seq > winner.Row.Sequence {
			winners[slotKey] = SlotUpdate{Series: sample.Series, Row: row}
		}
	}

	result.Batch.Updates = make([]SlotUpdate, 0, len(winners))

	for _, update := range winners {
		result.Batch.Updates = append(result.Batch.Updates, update)
	}

	for key := range replayRequests {
		result.ReplayRequests = append(result.ReplayRequests, key)
	}

	sort.Slice(result.ReplayRequests, func(left, right int) bool {
		if result.ReplayRequests[left].Boot != result.ReplayRequests[right].Boot {
			return string(result.ReplayRequests[left].Boot[:]) < string(result.ReplayRequests[right].Boot[:])
		}

		return result.ReplayRequests[left].ClockSegment < result.ReplayRequests[right].ClockSegment
	})
	sort.Slice(result.Batch.Updates, func(left, right int) bool {
		if result.Batch.Updates[left].Series != result.Batch.Updates[right].Series {
			return result.Batch.Updates[left].Series < result.Batch.Updates[right].Series
		}

		return result.Batch.Updates[left].Row.Slot.Before(result.Batch.Updates[right].Row.Slot)
	})

	return result, nil
}

type rawSlotKey struct {
	series uint16
	slotMs int64
}

func floorSlotMillis(value, step int64) int64 {
	remainder := value % step

	if remainder < 0 {
		remainder += step
	}

	return value - remainder
}
