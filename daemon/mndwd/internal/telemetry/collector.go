package telemetry

import (
	"context"
	"math"

	"mndwd/internal/telemetry/system"
)

// NewCollector adapts the configured samplers to the ring's cpu, ram, temp order.
func NewCollector(load, temperature Sampler) system.Collector {
	return func(ctx context.Context) []float32 {
		unknown := float32(math.NaN())
		values := []float32{unknown, unknown, unknown}

		if load != nil {
			if sampled, err := load.Poll(ctx); err == nil {
				for index := 0; index < 2 && index < len(sampled); index++ {
					values[index] = floatValue(sampled[index])
				}
			}
		}

		if temperature != nil {
			if sampled, err := temperature.Poll(ctx); err == nil && len(sampled) > 0 {
				values[2] = floatValue(sampled[0])
			}
		}

		return values
	}
}

func floatValue(value Value) float32 {
	if !value.Known || math.IsNaN(value.V) || math.IsInf(value.V, 0) {
		return float32(math.NaN())
	}

	converted := float32(value.V)

	if math.IsInf(float64(converted), 0) {
		return float32(math.NaN())
	}

	return converted
}
