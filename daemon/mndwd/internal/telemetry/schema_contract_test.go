package telemetry

import (
	"reflect"
	"testing"
	"time"
)

func TestSnapshotAssumptionsMatchSeriesSpecs(t *testing.T) {
	specs := DefaultSeriesSpecs()
	want := []SeriesSpec{
		{ID: 1, Step: 3 * time.Minute, ValueKeys: []string{"cpu", "ram"}},
		{ID: 2, Step: 3 * time.Minute, ValueKeys: []string{"temperature"}},
	}

	if !reflect.DeepEqual(specs, want) {
		t.Fatalf("default series specs = %+v, want %+v", specs, want)
	}

	snapshot := emptySnapshot(true)

	for _, spec := range specs {
		for _, valueKey := range spec.ValueKeys {
			key, _, _, _, ok := snapshotValuePresentation(spec, valueKey)

			if !ok {
				t.Errorf("series %d value %q has no snapshot mapping", spec.ID, valueKey)

				continue
			}

			series, exists := snapshot.Keys[key]

			if !exists {
				t.Errorf("series %d value %q maps to missing API key %q", spec.ID, valueKey, key)

				continue
			}

			for _, tier := range []struct {
				name string
				step time.Duration
			}{{"fine", spec.Step}, {"coarse", time.Hour}} {
				if got := series.Tiers[tier.name].StepMs; got != tier.step.Milliseconds() {
					t.Errorf("API key %q tier %q step=%d, want %d", key, tier.name, got, tier.step.Milliseconds())
				}
			}
		}
	}
}
