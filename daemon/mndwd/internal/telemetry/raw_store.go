package telemetry

import (
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"mndwd/internal/telemetry/journal"
)

var (
	ErrUnknownSeries = errors.New("telemetry: unknown raw series")
	ErrInvalidQuery  = errors.New("telemetry: invalid raw query")
	ErrQueryTooLarge = errors.New("telemetry: raw query exceeds series capacity")
)

// Value is a telemetry value independent of any persistence or graph library.
type Value struct {
	V     float64
	Known bool
}

// SeriesSpec describes one fixed-step raw series.
type SeriesSpec struct {
	ID        uint16
	Step      time.Duration
	ValueKeys []string
}

// DefaultSeriesSpecs returns copies of the built-in telemetry series layout.
func DefaultSeriesSpecs() []SeriesSpec {
	return []SeriesSpec{
		{ID: 1, Step: 3 * time.Minute, ValueKeys: []string{"cpu", "ram"}},
		{ID: 2, Step: 3 * time.Minute, ValueKeys: []string{"temperature"}},
	}
}

// Row is one aligned UTC interval and its complete value vector.
type Row struct {
	Slot     time.Time
	Sequence uint64
	Values   []Value
}

// SlotUpdate updates one series slot.
type SlotUpdate struct {
	Series uint16
	Row    Row
}

// Batch contains updates reduced from a durable journal boundary.
type Batch struct {
	Updates []SlotUpdate
}

// State is a complete replacement snapshot of raw rows.
type State struct {
	Rows map[uint16][]Row
}

// Query selects slot starts in the UTC half-open interval [Start, End).
type Query struct {
	Series uint16
	Start  time.Time
	End    time.Time
}

type rawSeries struct {
	spec       SeriesSpec
	stepMs     int64
	capacity   int
	starts     []int64
	sequences  []uint64
	values     []float64
	known      []bool
	present    []bool
	maxOrdinal int64
	hasMax     bool
}

// RawStore is a bounded, fixed-capacity in-memory store. Its retention is
// derived from the journal limits supplied by its owner.
type RawStore struct {
	mu      sync.RWMutex
	limits  journal.Limits
	series  map[uint16]*rawSeries
	ordered []uint16
}

// NewRawStore builds fixed-capacity rings from the journal's retention limit.
func NewRawStore(limits journal.Limits, specs []SeriesSpec) (*RawStore, error) {
	if limits.Retention <= 0 {
		return nil, errors.New("telemetry: journal retention must be positive")
	}

	if len(specs) == 0 {
		return nil, errors.New("telemetry: at least one series spec is required")
	}

	store := &RawStore{limits: limits, series: make(map[uint16]*rawSeries, len(specs)), ordered: make([]uint16, 0, len(specs))}

	for _, spec := range specs {
		if spec.ID == 0 || spec.Step <= 0 || spec.Step%time.Millisecond != 0 || len(spec.ValueKeys) == 0 {
			return nil, fmt.Errorf("telemetry: invalid series spec %d", spec.ID)
		}

		if _, exists := store.series[spec.ID]; exists {
			return nil, fmt.Errorf("telemetry: duplicate series spec %d", spec.ID)
		}

		stepMs := spec.Step.Milliseconds()
		capacity64 := int64(limits.Retention) / int64(spec.Step)

		if int64(limits.Retention)%int64(spec.Step) != 0 {
			capacity64++
		}

		if capacity64 <= 0 || capacity64 > int64(maxInt()/len(spec.ValueKeys)) {
			return nil, fmt.Errorf("telemetry: invalid capacity for series %d", spec.ID)
		}

		keys := append([]string(nil), spec.ValueKeys...)

		for _, key := range keys {
			if key == "" {
				return nil, fmt.Errorf("telemetry: empty value key for series %d", spec.ID)
			}
		}

		spec.ValueKeys = keys
		series := newRawSeries(spec, stepMs, int(capacity64))
		store.series[spec.ID] = series
		store.ordered = append(store.ordered, spec.ID)
	}

	return store, nil
}

// Capacity reports the fixed slot capacity for a series, or zero if absent.
func (s *RawStore) Capacity(series uint16) int {
	s.mu.RLock()

	defer s.mu.RUnlock()

	if raw := s.series[series]; raw != nil {
		return raw.capacity
	}

	return 0
}

// Replace atomically replaces all series rows. Invalid input leaves state intact.
func (s *RawStore) Replace(state State) error {
	s.mu.Lock()

	defer s.mu.Unlock()

	prepared := make(map[uint16][]Row, len(state.Rows))

	for seriesID, rows := range state.Rows {
		series := s.series[seriesID]

		if series == nil {
			return fmt.Errorf("%w: %d", ErrUnknownSeries, seriesID)
		}

		for _, row := range rows {
			if err := validateRawRow(series, row); err != nil {
				return fmt.Errorf("telemetry: replace series %d: %w", seriesID, err)
			}
		}

		prepared[seriesID] = cloneRows(rows)
	}

	replacement := make(map[uint16]*rawSeries, len(s.series))

	for _, seriesID := range s.ordered {
		old := s.series[seriesID]
		next := newRawSeries(old.spec, old.stepMs, old.capacity)

		for _, row := range prepared[seriesID] {
			applyRawRow(next, row)
		}

		replacement[seriesID] = next
	}

	s.series = replacement

	return nil
}

// Apply applies a batch. For each slot the greatest sequence wins as a whole
// vector; stale updates and duplicate applications are ignored.
func (s *RawStore) Apply(batch Batch) error {
	s.mu.Lock()

	defer s.mu.Unlock()

	for _, update := range batch.Updates {
		series := s.series[update.Series]

		if series == nil {
			return fmt.Errorf("%w: %d", ErrUnknownSeries, update.Series)
		}

		if err := validateRawRow(series, update.Row); err != nil {
			return fmt.Errorf("telemetry: apply series %d: %w", update.Series, err)
		}
	}

	for _, update := range batch.Updates {
		applyRawRow(s.series[update.Series], update.Row)
	}

	return nil
}

// Read returns independent rows for slot starts in [Start, End), synthesizing
// unknown values where no sample occupies a requested slot.
func (s *RawStore) Read(query Query) ([]Row, error) {
	s.mu.RLock()

	defer s.mu.RUnlock()

	return s.readLocked(query)
}

// ReadMany returns copied rows for all queries while holding one read lock.
// This lets snapshot refreshes observe one consistent store generation.
func (s *RawStore) ReadMany(queries []Query) ([][]Row, error) {
	s.mu.RLock()

	defer s.mu.RUnlock()

	results := make([][]Row, len(queries))

	for index, query := range queries {
		rows, err := s.readLocked(query)
		if err != nil {
			return nil, err
		}

		results[index] = rows
	}

	return results, nil
}

func (s *RawStore) readLocked(query Query) ([]Row, error) {

	series := s.series[query.Series]

	if series == nil {
		return nil, fmt.Errorf("%w: %d", ErrUnknownSeries, query.Series)
	}

	startMs := query.Start.UTC().UnixMilli()
	endMs := query.End.UTC().UnixMilli()

	if endMs < startMs || (startMs < 0 && endMs > math.MaxInt64+startMs) || startMs%series.stepMs != 0 || endMs%series.stepMs != 0 {
		return nil, ErrInvalidQuery
	}

	count := (endMs - startMs) / series.stepMs

	if count > int64(series.capacity) {
		return nil, ErrQueryTooLarge
	}

	rows := make([]Row, 0, int(count))

	for rowIndex := int64(0); rowIndex < count; rowIndex++ {
		slotMs := startMs + rowIndex*series.stepMs
		row := Row{Slot: time.UnixMilli(slotMs).UTC(), Values: make([]Value, len(series.spec.ValueKeys))}
		ordinal := slotMs / series.stepMs
		index := ringIndex(ordinal, series.capacity)
		oldestRetained := series.maxOrdinal - int64(series.capacity) + 1

		if series.present[index] && series.starts[index] == slotMs && ordinal >= oldestRetained && ordinal <= series.maxOrdinal {
			row.Sequence = series.sequences[index]

			for valueIndex := range row.Values {
				flatIndex := index*len(row.Values) + valueIndex
				row.Values[valueIndex] = Value{V: series.values[flatIndex], Known: series.known[flatIndex]}
			}
		}

		rows = append(rows, row)
	}

	return rows, nil
}

// Bounds returns the oldest and newest retained row slot for a series.
func (s *RawStore) Bounds(seriesID uint16) (from, to time.Time, ok bool) {
	s.mu.RLock()

	defer s.mu.RUnlock()

	series := s.series[seriesID]

	if series == nil || !series.hasMax {
		return time.Time{}, time.Time{}, false
	}

	minOrdinal := series.maxOrdinal - int64(series.capacity) + 1
	var minMs, maxMs int64

	for index, present := range series.present {
		if !present {
			continue
		}

		ordinal := series.starts[index] / series.stepMs

		if ordinal < minOrdinal || ordinal > series.maxOrdinal {
			continue
		}

		if !ok || series.starts[index] < minMs {
			minMs = series.starts[index]
		}

		if !ok || series.starts[index] > maxMs {
			maxMs = series.starts[index]
		}

		ok = true
	}

	if !ok {
		return time.Time{}, time.Time{}, false
	}

	return time.UnixMilli(minMs).UTC(), time.UnixMilli(maxMs).UTC(), true
}

func newRawSeries(spec SeriesSpec, stepMs int64, capacity int) *rawSeries {
	valueCount := len(spec.ValueKeys)

	return &rawSeries{
		spec:      spec,
		stepMs:    stepMs,
		capacity:  capacity,
		starts:    make([]int64, capacity),
		sequences: make([]uint64, capacity),
		values:    make([]float64, capacity*valueCount),
		known:     make([]bool, capacity*valueCount),
		present:   make([]bool, capacity),
	}
}

func validateRawRow(series *rawSeries, row Row) error {
	if len(row.Values) != len(series.spec.ValueKeys) {
		return fmt.Errorf("got %d values, want %d", len(row.Values), len(series.spec.ValueKeys))
	}

	if row.Slot.UnixMilli()%series.stepMs != 0 {
		return errors.New("slot start is not aligned to series step")
	}

	return nil
}

func applyRawRow(series *rawSeries, row Row) {
	slotMs := row.Slot.UTC().UnixMilli()
	ordinal := slotMs / series.stepMs

	if series.hasMax && ordinal < series.maxOrdinal-int64(series.capacity)+1 {
		return
	}

	if !series.hasMax || ordinal > series.maxOrdinal {
		series.maxOrdinal = ordinal
		series.hasMax = true
	}

	index := ringIndex(ordinal, series.capacity)

	if series.present[index] {
		oldSlot := series.starts[index]

		if oldSlot == slotMs && series.sequences[index] >= row.Sequence {
			return
		}

		if oldSlot != slotMs && oldSlot > slotMs {
			return
		}
	}

	series.starts[index] = slotMs
	series.sequences[index] = row.Sequence
	series.present[index] = true

	for valueIndex, value := range row.Values {
		flatIndex := index*len(row.Values) + valueIndex

		if value.Known && !math.IsNaN(value.V) && !math.IsInf(value.V, 0) {
			series.values[flatIndex] = value.V
			series.known[flatIndex] = true
		} else {
			series.values[flatIndex] = 0
			series.known[flatIndex] = false
		}
	}
}

func ringIndex(ordinal int64, capacity int) int {
	index := ordinal % int64(capacity)

	if index < 0 {
		index += int64(capacity)
	}

	return int(index)
}

func cloneRows(rows []Row) []Row {
	result := make([]Row, len(rows))

	for index, row := range rows {
		result[index] = Row{Slot: row.Slot, Sequence: row.Sequence, Values: append([]Value(nil), row.Values...)}
	}

	return result
}

func maxInt() int {
	return int(^uint(0) >> 1)
}
