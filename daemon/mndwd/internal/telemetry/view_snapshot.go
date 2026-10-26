package telemetry

import (
	"math"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/system"
)

const ringDelay = 10 * time.Second

const (
	ringFineSlots   = 480
	ringCoarseSlots = 14_400
)

func buildViewSnapshot(view system.View, supported map[uint16]bool) *Snapshot {
	snapshot := emptySnapshot(true)
	stepMs := int64(ring.SystemSchema(ring.KindHistory).StepMs)
	cutoffMs := view.NowMs - ringDelay.Milliseconds()
	fineEndMs := floorToStep(cutoffMs, stepMs)
	coarseEndMs := floorToStep(cutoffMs, time.Hour.Milliseconds())
	fineStartSlot := fineEndMs/stepMs - ringFineSlots
	coarseStartSlot := coarseEndMs/stepMs - ringCoarseSlots

	fineRows := viewRows(view.Window, fineStartSlot, ringFineSlots, stepMs)
	coarseRows := viewRows(view.Window, coarseStartSlot, ringCoarseSlots, stepMs)

	for _, item := range []struct {
		key   string
		value int
		step  time.Duration
		scale float64
		label string
		unit  string
	}{
		{key: "cpu", value: 0, step: 3 * time.Minute, scale: 1, label: "CPU", unit: "percent"},
		{key: "ram", value: 1, step: 3 * time.Minute, scale: 1, label: "RAM", unit: "percent"},
		{key: "temp", value: 2, step: 3 * time.Minute, scale: 1000, label: "cpu-thermal", unit: "celsius"},
	} {
		series := snapshot.Keys[item.key]
		series.Label = item.label
		series.Unit = item.unit
		series.Tiers["fine"] = fineTierSnapshot(fineRows, item.value, item.step, item.scale)
		series.Tiers["coarse"] = coarseTierSnapshot(coarseRows, item.value, item.step, item.scale)
		snapshot.Keys[item.key] = series
	}

	end := snapshotHistoryEnd(snapshot)
	current := end != nil && view.Anchored && !view.ReplayPending
	snapshot.Clock = clockMetadata(view.Anchored, end, current, view.ReplayPending)

	applySupportedSeries(snapshot, supported)

	return snapshot
}

func floorToStep(value, step int64) int64 {
	if step <= 0 {
		return value
	}

	remainder := value % step

	if remainder < 0 {
		remainder += step
	}

	return value - remainder
}

func viewRows(window func(startSlot int64, count int) [][]float32, startSlot int64, count int, stepMs int64) []Row {
	rows := make([]Row, count)
	var values [][]float32

	if window != nil {
		values = window(startSlot, count)
	}

	for index := range rows {
		row := Row{
			Slot:   time.UnixMilli((startSlot + int64(index)) * stepMs).UTC(),
			Values: make([]Value, 3),
		}

		if index < len(values) {
			for valueIndex, value := range values[index] {
				if valueIndex >= len(row.Values) || math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
					continue
				}

				row.Values[valueIndex] = Value{V: ring.ToFloat64(value), Known: true}
			}
		}

		rows[index] = row
	}

	return rows
}
