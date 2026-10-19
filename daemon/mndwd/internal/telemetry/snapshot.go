package telemetry

import (
	"context"
	"math"
	"sync"
	"time"

	"mndwd/internal/telemetry/clock"
)

type Sample struct {
	Timestamp int64    `json:"ts"`
	Min       *float64 `json:"min"`
	Max       *float64 `json:"max"`
	Mean      *float64 `json:"mean"`
	OK        bool     `json:"ok"`
}

type TierSnapshot struct {
	StepMs  int64    `json:"stepMs"`
	Samples []Sample `json:"samples"`
}

type SeriesSnapshot struct {
	Label     string                  `json:"label,omitempty"`
	Supported bool                    `json:"supported"`
	Unit      string                  `json:"unit"`
	Tiers     map[string]TierSnapshot `json:"tiers"`
}

type Snapshot struct {
	Keys      map[string]SeriesSnapshot `json:"keys"`
	Gathering struct {
		Enabled bool `json:"enabled"`
	} `json:"gathering"`
	Clock             *ClockMetadata `json:"clock,omitempty"`
	SessionConfigured bool           `json:"sessionConfigured"`
}

type ProjectedPoint struct {
	Time  int64    `json:"time"`
	Value *float64 `json:"value"`
}

type ProjectedSegment struct {
	Data []ProjectedPoint `json:"data"`
}

type ProjectedBandPoint struct {
	Time int64   `json:"time"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
}

type ProjectedBand struct {
	ID    string               `json:"id"`
	Data  []ProjectedBandPoint `json:"data"`
	Color string               `json:"color"`
}

type ProjectedValueDomain struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

type ProjectedSeries struct {
	Label       string                `json:"label,omitempty"`
	Supported   bool                  `json:"supported"`
	Unit        string                `json:"unit"`
	Points      []ProjectedPoint      `json:"points"`
	Segments    []ProjectedSegment    `json:"segments"`
	Bands       []ProjectedBand       `json:"bands"`
	ValueDomain *ProjectedValueDomain `json:"valueDomain,omitempty"`
}

type ProjectedSnapshot struct {
	Keys      map[string]ProjectedSeries `json:"keys"`
	Gathering struct {
		Enabled bool `json:"enabled"`
	} `json:"gathering"`
	Clock             *ClockMetadata `json:"clock,omitempty"`
	SessionConfigured bool           `json:"sessionConfigured"`
}

type SnapshotCache struct {
	history           *History
	specs             []SeriesSpec
	now               func() time.Time
	sessionConfigured func() bool

	mu              sync.Mutex
	snapshot        *Snapshot
	supportedSeries map[uint16]bool
}

func NewSnapshotCache(history *History, now func() time.Time) *SnapshotCache {
	if now == nil {
		now = time.Now
	}

	specs := DefaultSeriesSpecs()

	if history != nil {
		specs = history.SeriesSpecs()
	}

	return &SnapshotCache{history: history, specs: specs, now: now}
}

// Get returns the last published immutable snapshot. It never touches disk;
// a pipeline-owned refresher owns snapshot refreshes.
func (c *SnapshotCache) Get(_ context.Context, enabled bool) (*Snapshot, error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	configured := c.sessionConfigured != nil && c.sessionConfigured()

	if !enabled {
		snapshot := emptySnapshot(false)

		if c.snapshot != nil {
			snapshot = cloneSnapshot(c.snapshot)
			snapshot.Gathering.Enabled = false
		}

		snapshot.SessionConfigured = configured

		return snapshot, nil
	}

	if c.snapshot != nil {
		snapshot := cloneSnapshot(c.snapshot)
		snapshot.SessionConfigured = configured

		return snapshot, nil
	}

	// No refresh has completed yet: report an empty snapshot with false
	// freshness rather than querying an epoch window.
	snapshot := emptySnapshot(true)

	applySupportedSeries(snapshot, c.supportedSeries)

	snapshot.SessionConfigured = configured

	return snapshot, nil
}

// Publish atomically replaces the cached snapshot with a refreshed one.
func (c *SnapshotCache) Publish(snapshot *Snapshot) {
	if snapshot == nil {
		return
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	c.snapshot = cloneSnapshot(snapshot)
}

// SetSupportedSeries records which sampler series are available, so the
// snapshot can distinguish "no data yet" from "device lacks this sensor".
func (c *SnapshotCache) SetSupportedSeries(supported map[uint16]bool) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.supportedSeries = make(map[uint16]bool, len(supported))

	for series, enabled := range supported {
		c.supportedSeries[series] = enabled
	}
}

// SetHistory attaches the canonical raw projection owned by Capability.
func (c *SnapshotCache) SetHistory(history *History) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.history = history
	c.specs = DefaultSeriesSpecs()

	if history != nil {
		c.specs = history.SeriesSpecs()
	}
}

// SetSessionConfigured registers the callback that reports whether the
// persistent RCI session is configured. The telemetry API includes this
// flag so consumers know whether durable history can be collected.
func (c *SnapshotCache) SetSessionConfigured(fn func() bool) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.sessionConfigured = fn
}

// Refresh copies raw rows and projects fine and coarse tiers before publishing
// one immutable snapshot.
func (c *SnapshotCache) Refresh(ctx context.Context, status PipelineStatus) (*Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()

	history := c.history
	specs := cloneSeriesSpecs(c.specs)

	c.mu.Unlock()

	snapshot, err := c.refresh(history, specs)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()

	supported := c.supportedSeries

	c.mu.Unlock()
	applySupportedSeries(snapshot, supported)

	c.mu.Lock()

	configured := c.sessionConfigured != nil && c.sessionConfigured()

	c.mu.Unlock()

	snapshot.SessionConfigured = configured

	metadata := metadataFromStatus(snapshot, status)
	snapshot.Clock = metadata

	c.Publish(snapshot)

	return snapshot, nil
}

// metadataFromStatus derives clock metadata from the published snapshot and
// pipeline state. A failed or stale series makes freshness false.
func metadataFromStatus(snapshot *Snapshot, status PipelineStatus) *ClockMetadata {
	var end *int64

	if snapshot != nil {
		for _, series := range snapshot.Keys {
			for _, tier := range series.Tiers {
				if len(tier.Samples) == 0 {
					continue
				}

				last := tier.Samples[len(tier.Samples)-1]

				if !last.OK || last.Mean == nil || last.Timestamp <= 0 {
					continue
				}

				if end == nil || last.Timestamp > *end {
					value := last.Timestamp
					end = &value
				}
			}
		}
	}

	state := status.Clock.State

	if state == "" {
		state = clock.Unanchored
	}

	current := end != nil && status.Clock.State == clock.Anchored && status.PendingSamples == 0

	return clockMetadata(state, end, current, status.PendingSamples > 0)
}

func (c *SnapshotCache) refresh(history *History, specs []SeriesSpec) (*Snapshot, error) {
	snapshot := emptySnapshot(true)

	if history == nil {
		return snapshot, nil
	}

	now := c.now().UTC()
	fineStep := 3 * time.Minute
	fineEnd := now.Truncate(fineStep)
	fineStart := fineEnd.Add(-24 * time.Hour)
	coarseEnd := now.Truncate(time.Hour)
	coarseStart := coarseEnd.Add(-30 * 24 * time.Hour)
	queries := make([]Query, 0, len(specs)*2)

	for _, spec := range specs {
		queries = append(queries,
			Query{Series: spec.ID, Start: fineStart, End: fineEnd},
			Query{Series: spec.ID, Start: coarseStart, End: coarseEnd},
		)
	}

	windows, err := history.ReadMany(queries)
	if err != nil {
		return nil, err
	}

	for specIndex, spec := range specs {
		fineRows := windows[specIndex*2]
		coarseRows := windows[specIndex*2+1]

		for valueIndex, valueKey := range spec.ValueKeys {
			key, label, unit, scale, ok := snapshotValuePresentation(spec, valueKey)

			if !ok {
				continue
			}

			series := snapshot.Keys[key]
			series.Tiers["fine"] = fineTierSnapshot(fineRows, valueIndex, spec.Step, scale)
			series.Tiers["coarse"] = coarseTierSnapshot(coarseRows, valueIndex, spec.Step, scale)
			series.Label = label
			series.Unit = unit
			snapshot.Keys[key] = series
		}
	}

	return snapshot, nil
}

func snapshotValuePresentation(spec SeriesSpec, valueKey string) (key, label, unit string, scale float64, ok bool) {
	switch {
	case spec.ID == 1 && valueKey == "cpu":
		return "cpu", "CPU", "percent", 1, true
	case spec.ID == 1 && valueKey == "ram":
		return "ram", "RAM", "percent", 1, true
	case spec.ID == 2 && valueKey == "temperature":
		return "temp", "cpu-thermal", "celsius", 1000, true
	default:
		return "", "", "", 1, false
	}
}

func fineTierSnapshot(rows []Row, valueIndex int, step time.Duration, scale float64) TierSnapshot {
	tier := TierSnapshot{StepMs: step.Milliseconds(), Samples: make([]Sample, 0, len(rows))}

	for _, row := range rows {
		tier.Samples = append(tier.Samples, rawSample(row, valueIndex, step, scale))
	}

	return tier
}

func coarseTierSnapshot(rows []Row, valueIndex int, step time.Duration, scale float64) TierSnapshot {
	tier := TierSnapshot{StepMs: time.Hour.Milliseconds(), Samples: []Sample{}}

	if step <= 0 || time.Hour%step != 0 {
		return tier
	}

	perHour := int(time.Hour / step)
	tier.Samples = make([]Sample, 0, len(rows)/perHour)

	for offset := 0; offset+perHour <= len(rows); offset += perHour {
		start := rows[offset].Slot
		var count int
		var sum, minimum, maximum float64

		for _, row := range rows[offset : offset+perHour] {
			if valueIndex >= len(row.Values) {
				continue
			}

			value := row.Values[valueIndex]

			if !value.Known || math.IsNaN(value.V) || math.IsInf(value.V, 0) {
				continue
			}

			value.V /= scale

			if count == 0 || value.V < minimum {
				minimum = value.V
			}

			if count == 0 || value.V > maximum {
				maximum = value.V
			}

			sum += value.V
			count++
		}

		sample := Sample{Timestamp: start.Add(time.Hour).UnixMilli()}

		if count >= (perHour+1)/2 {
			mean := sum / float64(count)
			sample.Min = floatPointer(minimum)
			sample.Max = floatPointer(maximum)
			sample.Mean = floatPointer(mean)
			sample.OK = true
		}

		tier.Samples = append(tier.Samples, sample)
	}

	return tier
}

func rawSample(row Row, valueIndex int, step time.Duration, scale float64) Sample {
	sample := Sample{Timestamp: row.Slot.Add(step).UnixMilli()}

	if valueIndex >= len(row.Values) {
		return sample
	}

	value := row.Values[valueIndex]

	if !value.Known || math.IsNaN(value.V) || math.IsInf(value.V, 0) {
		return sample
	}

	value.V /= scale
	sample.Min = floatPointer(value.V)
	sample.Max = floatPointer(value.V)
	sample.Mean = floatPointer(value.V)
	sample.OK = true

	return sample
}

func floatPointer(value float64) *float64 {
	return &value
}

// seriesKeyMap maps journal series IDs to snapshot keys. Series 2 is temperature.
var seriesKeyMap = map[uint16]string{2: "temp"}

func applySupportedSeries(snapshot *Snapshot, supported map[uint16]bool) {
	if snapshot == nil || supported == nil {
		return
	}

	for series, key := range seriesKeyMap {
		if s, ok := snapshot.Keys[key]; ok && supported[series] {
			s.Supported = true
			snapshot.Keys[key] = s
		}
	}
}

func emptySnapshot(enabled bool) *Snapshot {
	snapshot := &Snapshot{Keys: map[string]SeriesSnapshot{}}
	snapshot.Gathering.Enabled = enabled

	for _, item := range []struct {
		key, label, unit string
		supported        bool
	}{{"cpu", "CPU", "percent", true}, {"ram", "RAM", "percent", true}, {"temp", "cpu-thermal", "celsius", false}} {
		snapshot.Keys[item.key] = SeriesSnapshot{
			Label:     item.label,
			Supported: item.supported,
			Unit:      item.unit,
			Tiers: map[string]TierSnapshot{
				"fine":   {StepMs: 180000, Samples: []Sample{}},
				"coarse": {StepMs: 3600000, Samples: []Sample{}},
			},
		}
	}

	return snapshot
}

func cloneSnapshot(input *Snapshot) *Snapshot {
	if input == nil {
		return nil
	}

	output := emptySnapshot(input.Gathering.Enabled)
	output.SessionConfigured = input.SessionConfigured

	if input.Clock != nil {
		clock := *input.Clock

		if input.Clock.HistoryEndMs != nil {
			value := *input.Clock.HistoryEndMs
			clock.HistoryEndMs = &value
		}

		output.Clock = &clock
	}

	for key, series := range input.Keys {
		copied := SeriesSnapshot{Label: series.Label, Supported: series.Supported, Unit: series.Unit, Tiers: map[string]TierSnapshot{}}

		for tierName, tier := range series.Tiers {
			samples := make([]Sample, len(tier.Samples))

			for index, sample := range tier.Samples {
				samples[index] = Sample{
					Timestamp: sample.Timestamp,
					Min:       cloneFloat(sample.Min),
					Max:       cloneFloat(sample.Max),
					Mean:      cloneFloat(sample.Mean),
					OK:        sample.OK,
				}
			}

			copied.Tiers[tierName] = TierSnapshot{StepMs: tier.StepMs, Samples: samples}
		}

		output.Keys[key] = copied
	}

	return output
}

func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}

	copy := *value

	return &copy
}
