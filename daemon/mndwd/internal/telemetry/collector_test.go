package telemetry

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
)

type collectorTestSampler struct {
	values    []Value
	err       error
	supported bool
}

func (s collectorTestSampler) Poll(context.Context) ([]Value, error) { return s.values, s.err }
func (s collectorTestSampler) Supported() bool                       { return s.supported }

func TestCollectorMapsValuesAndErrors(t *testing.T) {
	load := collectorTestSampler{values: []Value{{V: 12.5, Known: true}, {V: 40, Known: true}}, supported: true}
	temperature := collectorTestSampler{values: []Value{{V: 42000, Known: true}}, supported: true}
	values := NewCollector(load, temperature)(context.Background())

	if !reflect.DeepEqual(values, []float32{12.5, 40, 42000}) {
		t.Fatalf("values = %v, want [12.5 40 42000]", values)
	}

	temperature.err = errors.New("sensor read failed")
	values = NewCollector(load, temperature)(context.Background())

	if values[0] != 12.5 || values[1] != 40 || !math.IsNaN(float64(values[2])) {
		t.Fatalf("values after temperature error = %v, want CPU/RAM preserved and temperature NaN", values)
	}

	load.values[0].V = math.Inf(1)
	temperature.err = nil
	values = NewCollector(load, temperature)(context.Background())

	if !math.IsNaN(float64(values[0])) {
		t.Fatalf("infinite source became %v, want NaN", values[0])
	}
}
