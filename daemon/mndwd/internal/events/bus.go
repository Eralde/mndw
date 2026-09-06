package events

import (
	"errors"
	"sync"

	contractEvents "mndw.local/contracts/events"
)

const (
	EventRingCapacity       = 1024
	EventSubscriberCapacity = 64
	MaxEventSubscribers     = 8
)

var (
	ErrCursorExpired   = errors.New("event replay cursor expired")
	ErrSubscriberLimit = errors.New("event subscriber limit reached")
)

type Event = contractEvents.Event
type CancelFunc func()

type ReplayResult struct {
	Events  []Event
	HasMore bool
}

type ringEntry struct {
	sequence uint64
	event    Event
}

type subscription struct {
	channel chan Event
	filter  TopicFilter
	closed  bool
}

type Bus struct {
	mu              sync.Mutex
	ring            []ringEntry
	ringCapacity    int
	nextSequence    uint64
	subscribers     map[*subscription]struct{}
	subscriberReady chan struct{}
}

func NewBus() *Bus {
	return &Bus{
		ringCapacity:    EventRingCapacity,
		subscribers:     make(map[*subscription]struct{}, MaxEventSubscribers),
		subscriberReady: make(chan struct{}),
	}
}

func (b *Bus) Publish(event Event) {
	b.mu.Lock()

	defer b.mu.Unlock()

	b.nextSequence++
	b.ring = append(b.ring, ringEntry{sequence: b.nextSequence, event: event})

	if len(b.ring) > b.ringCapacity {
		b.ring = b.ring[len(b.ring)-b.ringCapacity:]
	}

	for subscriber := range b.subscribers {
		if !subscriber.filter.Matches(string(event.Topic)) {
			continue
		}

		select {
		case subscriber.channel <- event:
		default:
			subscriber.closed = true

			close(subscriber.channel)
			delete(b.subscribers, subscriber)
		}
	}
}

func (b *Bus) Subscribe(filter TopicFilter) (<-chan Event, CancelFunc, error) {
	b.mu.Lock()

	defer b.mu.Unlock()

	if len(b.subscribers) >= MaxEventSubscribers {
		return nil, func() {}, ErrSubscriberLimit
	}

	subscriber := &subscription{
		channel: make(chan Event, EventSubscriberCapacity),
		filter:  filter,
	}
	b.subscribers[subscriber] = struct{}{}

	if b.subscriberReady == nil {
		b.subscriberReady = make(chan struct{})
	}

	close(b.subscriberReady)

	b.subscriberReady = make(chan struct{})

	return subscriber.channel, func() {
		b.cancel(subscriber)
	}, nil
}

func (b *Bus) subscriberReadyForTest() <-chan struct{} {
	b.mu.Lock()

	defer b.mu.Unlock()

	if len(b.subscribers) > 0 {
		ready := make(chan struct{})

		close(ready)

		return ready
	}

	return b.subscriberReady
}

func (b *Bus) cancel(subscriber *subscription) {
	b.mu.Lock()

	defer b.mu.Unlock()

	if subscriber.closed {
		return
	}

	subscriber.closed = true

	delete(b.subscribers, subscriber)
	close(subscriber.channel)
}

func (b *Bus) Replay(after string, filter TopicFilter, limit int) (ReplayResult, error) {
	events, err := b.Snapshot(after, filter)
	if err != nil {
		return ReplayResult{}, err
	}

	if limit <= 0 {
		limit = 100
	}

	if limit > 500 {
		limit = 500
	}

	result := ReplayResult{Events: make([]Event, 0, limit)}

	for _, event := range events {
		if len(result.Events) == limit {
			result.HasMore = true

			break
		}

		result.Events = append(result.Events, event)
	}

	return result, nil
}

func (b *Bus) Snapshot(after string, filter TopicFilter) ([]Event, error) {
	b.mu.Lock()

	entries := append([]ringEntry(nil), b.ring...)

	b.mu.Unlock()

	start := 0

	if after != "" {
		found := false

		for index, entry := range entries {
			if entry.event.ID == after {
				start = index + 1
				found = true

				break
			}
		}

		if !found {
			return nil, ErrCursorExpired
		}
	}

	events := make([]Event, 0, len(entries)-start)

	for _, entry := range entries[start:] {
		if filter.Matches(string(entry.event.Topic)) {
			events = append(events, entry.event)
		}
	}

	return events, nil
}

func (b *Bus) setRingCapacityForTest(capacity int) {
	b.mu.Lock()

	defer b.mu.Unlock()

	if capacity < 1 {
		capacity = 1
	}

	b.ringCapacity = capacity

	if len(b.ring) > capacity {
		b.ring = b.ring[len(b.ring)-capacity:]
	}
}
