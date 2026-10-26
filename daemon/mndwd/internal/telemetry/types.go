package telemetry

import (
	"context"
	"time"
)

const (
	clockStateAnchored   = "anchored"
	clockStateUnanchored = "unanchored"
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

// ClockMetadata describes the calendar trust of one published snapshot.
type ClockMetadata struct {
	State          string `json:"state"`
	HistoryEndMs   *int64 `json:"historyEndMs"`
	HistoryCurrent bool   `json:"historyCurrent"`
	ReplayPending  bool   `json:"replayPending"`
}

// clockMetadata builds response metadata from a snapshot end and pipeline state.

func clockMetadata(anchored bool, historyEndMs *int64, current, replayPending bool) *ClockMetadata {
	state := clockStateUnanchored

	if anchored {
		state = clockStateAnchored
	}

	return &ClockMetadata{
		State:          state,
		HistoryEndMs:   historyEndMs,
		HistoryCurrent: current,
		ReplayPending:  replayPending,
	}
}

// Sampler polls one series. Failure yields unknown values, never a synthetic
// measurement.
type Sampler interface {
	Poll(context.Context) ([]Value, error)
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
