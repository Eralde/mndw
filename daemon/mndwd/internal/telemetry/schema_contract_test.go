package telemetry

import (
	"testing"
	"time"
)

func TestEmptySnapshotMatchesSeriesContract(t *testing.T) {
	snapshot := emptySnapshot(true)
	want := map[string]struct {
		label     string
		unit      string
		supported bool
	}{
		"cpu":  {label: "CPU", unit: "percent", supported: true},
		"ram":  {label: "RAM", unit: "percent", supported: true},
		"temp": {label: "cpu-thermal", unit: "celsius", supported: false},
	}

	if len(snapshot.Keys) != len(want) {
		t.Fatalf("snapshot keys = %v, want %d keys", snapshot.Keys, len(want))
	}

	for key, expected := range want {
		series, exists := snapshot.Keys[key]

		if !exists {
			t.Errorf("snapshot is missing API key %q", key)

			continue
		}

		if series.Label != expected.label || series.Unit != expected.unit || series.Supported != expected.supported {
			t.Errorf("API key %q = %+v, want label=%q unit=%q supported=%t", key, series, expected.label, expected.unit, expected.supported)
		}

		for _, tier := range []struct {
			name string
			step time.Duration
		}{{"fine", 3 * time.Minute}, {"coarse", time.Hour}} {
			if got := series.Tiers[tier.name].StepMs; got != tier.step.Milliseconds() {
				t.Errorf("API key %q tier %q step=%d, want %d", key, tier.name, got, tier.step.Milliseconds())
			}
		}
	}
}
