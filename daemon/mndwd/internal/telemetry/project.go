package telemetry

import (
	"fmt"
	"math"
	"sort"
)

const oneDayMs = 24 * 60 * 60 * 1000

func projectSeries(series SeriesSnapshot, rangeMs int64) ProjectedSeries {
	fine := series.Tiers["fine"]
	coarse := series.Tiers["coarse"]
	fineOnly := rangeMs < oneDayMs

	var now int64

	for _, sample := range fine.Samples {
		if sample.Timestamp > now {
			now = sample.Timestamp
		}
	}

	if !fineOnly {
		for _, sample := range coarse.Samples {
			if sample.Timestamp > now {
				now = sample.Timestamp
			}
		}
	}

	rangeStart := now - rangeMs

	fineSamples := make([]Sample, 0, len(fine.Samples))

	for _, sample := range fine.Samples {
		if sample.Timestamp >= rangeStart {
			fineSamples = append(fineSamples, sample)
		}
	}

	if fineOnly {
		sort.SliceStable(fineSamples, func(i, j int) bool {
			return fineSamples[i].Timestamp < fineSamples[j].Timestamp
		})

		return buildProjected(series, fineSamples)
	}

	oldestFine := int64(math.MaxInt64)

	for _, sample := range fineSamples {
		if sample.Timestamp < oldestFine {
			oldestFine = sample.Timestamp
		}
	}

	merged := make([]Sample, 0, len(fineSamples)+len(coarse.Samples))

	for _, sample := range coarse.Samples {
		if sample.Timestamp >= rangeStart && sample.Timestamp < oldestFine {
			merged = append(merged, sample)
		}
	}

	merged = append(merged, fineSamples...)

	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].Timestamp < merged[j].Timestamp
	})

	return buildProjected(series, merged)
}

func buildProjected(series SeriesSnapshot, samples []Sample) ProjectedSeries {
	points := make([]ProjectedPoint, len(samples))

	for index, sample := range samples {
		var value *float64

		if sample.OK && sample.Mean != nil {
			value = sample.Mean
		}

		points[index] = ProjectedPoint{Time: sample.Timestamp, Value: value}
	}

	segments := make([]ProjectedSegment, 0)
	current := make([]ProjectedPoint, 0)
	bandSegments := make([][]ProjectedBandPoint, 0)
	band := make([]ProjectedBandPoint, 0)

	for index, sample := range samples {
		if !sample.OK || sample.Mean == nil {
			if len(current) > 0 {
				segments = append(segments, ProjectedSegment{Data: current})
				current = nil
			}

			if len(band) > 0 {
				bandSegments = append(bandSegments, band)
				band = nil
			}

			continue
		}

		current = append(current, points[index])

		if sample.Min != nil && sample.Max != nil {
			band = append(band, ProjectedBandPoint{
				Time: sample.Timestamp,
				Min:  *sample.Min,
				Max:  *sample.Max,
			})
		} else if len(band) > 0 {
			bandSegments = append(bandSegments, band)
			band = nil
		}
	}

	if len(current) > 0 {
		segments = append(segments, ProjectedSegment{Data: current})
	}

	if len(band) > 0 {
		bandSegments = append(bandSegments, band)
	}

	bands := make([]ProjectedBand, len(bandSegments))

	for index, data := range bandSegments {
		bands[index] = ProjectedBand{ID: fmt.Sprintf("range-%d", index), Data: data, Color: "accent"}
	}

	var valueDomain *ProjectedValueDomain

	if series.Unit == "percent" {
		valueDomain = &ProjectedValueDomain{Min: 0, Max: 100}
	} else if series.Unit == "celsius" {
		valueDomain = temperatureValueDomain(bandSegments)
	}

	return ProjectedSeries{
		Label:       series.Label,
		Supported:   series.Supported,
		Unit:        series.Unit,
		Points:      points,
		Segments:    segments,
		Bands:       bands,
		ValueDomain: valueDomain,
	}
}

func temperatureValueDomain(bandSegments [][]ProjectedBandPoint) *ProjectedValueDomain {
	minVal := math.Inf(1)
	maxVal := math.Inf(-1)
	found := false

	for _, segment := range bandSegments {
		for _, point := range segment {
			found = true

			if point.Min < minVal {
				minVal = point.Min
			}

			if point.Max > maxVal {
				maxVal = point.Max
			}
		}
	}

	if !found {
		return nil
	}

	if minVal == maxVal {
		return &ProjectedValueDomain{Min: minVal - 5, Max: maxVal + 5}
	}

	return &ProjectedValueDomain{Min: math.Floor(minVal) - 2, Max: math.Ceil(maxVal) + 2}
}

func projectSnapshot(snapshot *Snapshot, rangeMs int64) *ProjectedSnapshot {
	projected := &ProjectedSnapshot{Keys: make(map[string]ProjectedSeries, len(snapshot.Keys))}
	projected.Gathering.Enabled = snapshot.Gathering.Enabled

	for key, series := range snapshot.Keys {
		projected.Keys[key] = projectSeries(series, rangeMs)
	}

	return projected
}
