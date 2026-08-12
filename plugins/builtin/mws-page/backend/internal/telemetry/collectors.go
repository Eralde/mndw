package telemetry

import (
	"sync"
	"time"
)

type Collector struct {
	mu                sync.Mutex
	persistentSamples map[string]PersistentTelemetry
	interval          time.Duration
}

func NewCollector() *Collector {
	return &Collector{
		persistentSamples: make(map[string]PersistentTelemetry),
		interval:          time.Minute,
	}
}

func (c *Collector) StorePersistent(id string, sample PersistentTelemetry) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.persistentSamples[id] = clonePersistentTelemetry(sample)
}

func (c *Collector) Persistent(id string, now time.Time) (PersistentTelemetry, bool) {
	c.mu.Lock()

	defer c.mu.Unlock()

	sample, ok := c.persistentSamples[id]

	if !ok || now.Sub(sample.SampledAt) > 3*c.interval {
		return PersistentTelemetry{}, false
	}

	return clonePersistentTelemetry(sample), true
}

func clonePersistentTelemetry(sample PersistentTelemetry) PersistentTelemetry {
	clone := sample
	clone.System.Uptime = append([]byte(nil), sample.System.Uptime...)
	clone.CPURRD.Data = cloneRrdTicks(sample.CPURRD.Data)
	clone.MemoryRRD.Data = cloneRrdTicks(sample.MemoryRRD.Data)

	return clone
}

func cloneRrdTicks(ticks []RrdTick) []RrdTick {
	if ticks == nil {
		return nil
	}

	clone := make([]RrdTick, len(ticks))

	for index, tick := range ticks {
		clone[index] = RrdTick{T: append([]byte(nil), tick.T...), V: tick.V}
	}

	return clone
}
