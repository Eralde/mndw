package telemetry

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/clock"
)

const snapshotRefreshAge = 15 * time.Minute

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
	load              SnapshotReader
	temperature       SnapshotReader
	now               func() time.Time
	sessionConfigured func() bool

	mu              sync.Mutex
	snapshot        *Snapshot
	refreshed       time.Time
	refreshErr      error
	refreshing      bool
	wait            chan struct{}
	supportedSeries map[uint16]bool
}

func NewSnapshotCache(load SnapshotReader, temperature SnapshotReader, now func() time.Time) *SnapshotCache {
	if now == nil {
		now = time.Now
	}

	return &SnapshotCache{load: load, temperature: temperature, now: now}
}

// Get returns the last published immutable snapshot. It never invokes RRDtool
// and never touches disk: a pipeline-owned refresher owns that work.
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

	// No dated history yet: report an empty snapshot with false freshness
	// rather than querying an epoch window.
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
	c.refreshed = c.now()
	c.refreshErr = nil
}

// SetSupportedSeries records which sampler series are available, so the
// snapshot can distinguish "no data yet" from "device lacks this sensor".
func (c *SnapshotCache) SetSupportedSeries(supported map[uint16]bool) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.supportedSeries = supported
}

// SetSessionConfigured registers the callback that reports whether the
// persistent RCI session is configured. The telemetry API includes this
// flag so consumers know whether durable history can be collected.
func (c *SnapshotCache) SetSessionConfigured(fn func() bool) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.sessionConfigured = fn
}

// Refresh rebuilds the snapshot from derived files and publishes it. It is the
// only path that invokes RRDtool, and only the pipeline refresher calls it.
func (c *SnapshotCache) Refresh(ctx context.Context, status PipelineStatus) (*Snapshot, error) {
	snapshot, err := c.refresh(ctx)
	if err != nil {
		c.mu.Lock()

		c.refreshErr = err

		c.mu.Unlock()

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

				if last.Timestamp <= 0 {
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

func (c *SnapshotCache) refresh(ctx context.Context) (*Snapshot, error) {
	if c.load == nil || c.temperature == nil {
		return nil, errors.New("telemetry readers unavailable")
	}

	now := c.now().UTC()
	fineEnd := now.Truncate(3 * time.Minute)
	coarseEnd := now.Truncate(time.Hour)
	var group sync.WaitGroup

	group.Add(2)

	var loadResults, tempResults []rrd.FetchResult
	var loadErr, tempErr error

	go func() {
		defer group.Done()

		loadResults, loadErr = fetchRanges(ctx, c.load, fineEnd, coarseEnd)
	}()

	go func() {
		defer group.Done()

		tempResults, tempErr = fetchRanges(ctx, c.temperature, fineEnd, coarseEnd)
	}()

	group.Wait()

	if loadErr != nil {
		return nil, loadErr
	}

	if tempErr != nil {
		return nil, tempErr
	}

	snapshot := emptySnapshot(true)
	snapshot.Keys["cpu"] = seriesFromResults("CPU", "percent", true, loadResults, 0, 1)
	snapshot.Keys["ram"] = seriesFromResults("RAM", "percent", true, loadResults, 1, 1)
	snapshot.Keys["temp"] = seriesFromResults("cpu-thermal", "celsius", false, tempResults, 0, 1000)

	return snapshot, nil
}

func fetchRanges(ctx context.Context, reader SnapshotReader, fineEnd, coarseEnd time.Time) ([]rrd.FetchResult, error) {
	requests := make([]rrd.FetchRequest, 0, 6)

	for _, rangeSpec := range []struct {
		resolution time.Duration
		start      time.Time
		end        time.Time
	}{
		{3 * time.Minute, fineEnd.Add(-24 * time.Hour), fineEnd},
		{time.Hour, coarseEnd.Add(-30 * 24 * time.Hour), coarseEnd},
	} {
		for _, cf := range []string{"AVERAGE", "MIN", "MAX"} {
			requests = append(requests, rrd.FetchRequest{CF: cf, Resolution: rangeSpec.resolution, Start: rangeSpec.start, End: rangeSpec.end})
		}
	}

	return reader.FetchGroup(ctx, requests)
}

func seriesFromResults(label, unit string, supported bool, results []rrd.FetchResult, dsIndex int, scale float64) SeriesSnapshot {
	series := SeriesSnapshot{Label: label, Supported: supported, Unit: unit, Tiers: map[string]TierSnapshot{}}

	for _, tier := range []struct {
		name string
		base int
	}{
		{"fine", 0},
		{"coarse", 3},
	} {
		if len(results) < tier.base+3 {
			series.Tiers[tier.name] = TierSnapshot{Samples: []Sample{}}

			continue
		}

		average, minimum, maximum := results[tier.base], results[tier.base+1], results[tier.base+2]
		tierSnapshot := TierSnapshot{StepMs: average.Step.Milliseconds(), Samples: []Sample{}}
		minByTime := valuesByTime(minimum, dsIndex, scale)
		maxByTime := valuesByTime(maximum, dsIndex, scale)

		for _, row := range average.Rows {
			if row.Timestamp.Unix() <= average.Start.Unix() || row.Timestamp.After(average.End) {
				continue
			}

			mean := valueAt(row.Values, dsIndex, scale)
			min, minOK := minByTime[row.Timestamp.Unix()]
			max, maxOK := maxByTime[row.Timestamp.Unix()]
			sample := Sample{Timestamp: row.Timestamp.UnixMilli(), Min: min, Max: max, Mean: mean, OK: mean != nil && minOK && maxOK}

			if !sample.OK {
				sample.Min, sample.Max, sample.Mean = nil, nil, nil
			}

			tierSnapshot.Samples = append(tierSnapshot.Samples, sample)
		}

		series.Tiers[tier.name] = tierSnapshot
	}

	return series
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

func valuesByTime(result rrd.FetchResult, dsIndex int, scale float64) map[int64]*float64 {
	values := make(map[int64]*float64, len(result.Rows))

	for _, row := range result.Rows {
		values[row.Timestamp.Unix()] = valueAt(row.Values, dsIndex, scale)
	}

	return values
}

func valueAt(values []rrd.Value, index int, scale float64) *float64 {
	if index < 0 || index >= len(values) || !values[index].Known || math.IsNaN(values[index].V) || math.IsInf(values[index].V, 0) {
		return nil
	}

	value := values[index].V / scale

	return &value
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
			copied.Tiers[tierName] = TierSnapshot{StepMs: tier.StepMs, Samples: append([]Sample(nil), tier.Samples...)}
		}

		output.Keys[key] = copied
	}

	return output
}
