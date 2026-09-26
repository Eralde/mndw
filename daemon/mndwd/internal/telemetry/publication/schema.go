package publication

import (
	"path/filepath"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

const (
	loadFileName = "mndw-load-v1.rrd"
	tempFileName = "mndw-temp-v1.rrd"
)

// NewReaders returns the handles consumed by SnapshotCache. DerivedStore uses
// the same schemas when it creates or rebuilds these files.
func NewReaders(executor rrd.Executor, dir string) (load *rrd.File, temperature *rrd.File, err error) {
	load, err = rrd.NewFile(executor, filepath.Join(dir, loadFileName), loadSpec())
	if err != nil {
		return nil, nil, err
	}

	temperature, err = rrd.NewFile(executor, filepath.Join(dir, tempFileName), tempSpec())
	if err != nil {
		return nil, nil, err
	}

	return load, temperature, nil
}

func loadSpec() rrd.CreateSpec {
	return rrd.CreateSpec{
		Step: journal.StepForSeries(1),
		DS: []rrd.DSSpec{
			{Name: "cpu", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(0), Max: floatPtr(100)},
			{Name: "ram", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(0), Max: floatPtr(100)},
		},
		RRA: tierRRAs(),
	}
}

func tempSpec() rrd.CreateSpec {
	return rrd.CreateSpec{
		Step: journal.StepForSeries(2),
		DS: []rrd.DSSpec{
			{Name: "value", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(-100000), Max: floatPtr(250000)},
		},
		RRA: tierRRAs(),
	}
}

func tierRRAs() []rrd.RRASpec {
	result := make([]rrd.RRASpec, 0, 6)

	for _, stepsRows := range []struct{ steps, rows int }{{1, 480}, {20, 720}} {
		for _, cf := range []string{"AVERAGE", "MIN", "MAX"} {
			result = append(result, rrd.RRASpec{CF: cf, XFF: 0.5, Steps: stepsRows.steps, Rows: stepsRows.rows})
		}
	}

	return result
}

func floatPtr(value float64) *float64 {
	return &value
}
