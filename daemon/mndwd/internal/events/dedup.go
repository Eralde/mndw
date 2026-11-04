package events

import (
	"encoding/json"
	"hash/fnv"
	"strings"
	"sync"
	"time"
)

const DedupWindow = 5 * time.Second

type dedupEntry struct {
	category    string
	key         string
	source      string
	payloadHash uint64
	ts          time.Time
}

type Deduplicator struct {
	mu     sync.Mutex
	now    func() time.Time
	recent []dedupEntry
}

// DeduplicatingPublisher applies hook preference at the shared ingestion
// boundary so hook and log sources use one five-second window.
type DeduplicatingPublisher struct {
	publisher    Publisher
	deduplicator *Deduplicator
}

func NewDeduplicatingPublisher(publisher Publisher, deduplicator *Deduplicator) Publisher {
	if deduplicator == nil {
		return publisher
	}

	return &DeduplicatingPublisher{publisher: publisher, deduplicator: deduplicator}
}

func (p *DeduplicatingPublisher) Publish(event Event) {
	if p == nil || p.publisher == nil || !p.deduplicator.Accept(event) {
		return
	}

	p.publisher.Publish(event)
}

func NewDeduplicator(now func() time.Time) *Deduplicator {
	if now == nil {
		now = time.Now
	}

	return &Deduplicator{now: now}
}

func (d *Deduplicator) Accept(event Event) bool {
	now := d.now()
	category, key := dedupIdentity(event)
	hash := hashPayload(event)

	d.mu.Lock()

	defer d.mu.Unlock()

	cutoff := now.Add(-DedupWindow)
	kept := d.recent[:0]

	for _, entry := range d.recent {
		if entry.ts.After(cutoff) {
			kept = append(kept, entry)
		}
	}

	d.recent = kept

	for _, entry := range d.recent {
		if entry.category == category && entry.key == key {
			if event.Source == "log" && entry.source == "hook" {
				return false
			}

			if event.Source == "hook" && entry.source == "hook" && entry.payloadHash == hash {
				return false
			}
		}
	}

	d.recent = append(d.recent, dedupEntry{category: category, key: key, source: string(event.Source), payloadHash: hash, ts: now})

	return true
}

func hashPayload(event Event) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(event.Payload)

	return h.Sum64()
}

func dedupIdentity(event Event) (string, string) {
	category := strings.Split(string(event.Topic), ".")[0]
	var payload map[string]any

	if json.Unmarshal(event.Payload, &payload) != nil {
		return category, event.ID
	}

	for _, key := range []string{"interface", "link", "mac", "device", "directory"} {
		if value, ok := payload[key].(string); ok && value != "" {
			return category, value
		}
	}

	return category, string(event.Topic)
}
