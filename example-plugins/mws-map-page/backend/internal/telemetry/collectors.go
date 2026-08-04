package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"mws-map-page/internal/auth"
	"mws-map-page/internal/credentials"
	"mws-map-page/internal/session"
)

type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type Collector struct {
	mu                sync.Mutex
	samples           map[string]Vitals
	persistentSamples map[string]PersistentTelemetry
	epoch             *credentials.Epoch
	clock             Clock
	interval          time.Duration
	adapter           FieldAdapter
	holder            *session.Holder
}

func NewCollector(holder *session.Holder, epoch *credentials.Epoch, adapter FieldAdapter) *Collector {
	return &Collector{samples: make(map[string]Vitals), persistentSamples: make(map[string]PersistentTelemetry), holder: holder, epoch: epoch, clock: realClock{}, interval: time.Minute, adapter: adapter}
}

func (c *Collector) SetClock(clock Clock) {
	if clock != nil {
		c.clock = clock
	}
}

func (c *Collector) SetInterval(interval time.Duration) {
	if interval > 0 {
		c.interval = interval
	}
}

func (c *Collector) Collect(ctx context.Context, id string, target auth.Target, query func(context.Context, http.CookieJar) ([]byte, error)) error {
	if c.holder == nil {
		return nil
	}
	token := uint64(0)
	if c.epoch != nil {
		token = c.epoch.Current()
	}
	var data []byte
	if err := c.holder.WithSession(ctx, id, target, func(operationCtx context.Context, jar http.CookieJar) error {
		var err error
		data, err = query(operationCtx, jar)
		return err
	}); err != nil {
		return err
	}
	vitals, err := c.adapter.Parse(data, c.clock.Now())
	if err != nil {
		return err
	}
	return c.Store(id, vitals, token)
}

func (c *Collector) Store(id string, vitals Vitals, token uint64) error {
	if c.epoch != nil && !c.epoch.CurrentIs(token) {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.epoch != nil && !c.epoch.CurrentIs(token) {
		return nil
	}
	c.samples[id] = vitals
	return nil
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

func (c *Collector) Vitals(id string, now time.Time, online bool) *Vitals {
	c.mu.Lock()
	defer c.mu.Unlock()
	vitals, ok := c.samples[id]
	if !ok || !online || now.Sub(vitals.SampledAt) > 3*c.interval {
		return nil
	}
	copy := vitals
	return &copy
}

func (c *Collector) Snapshot(nodes []Node, now time.Time) Snapshot {
	result := Snapshot{Nodes: make([]Node, 0, len(nodes))}
	for _, node := range nodes {
		node.Vitals = c.Vitals(node.ID, now, node.Online)
		result.Nodes = append(result.Nodes, node)
	}
	return result
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

func Encode(data any) ([]byte, error) { return json.Marshal(data) }
