package events

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

func (m *StorageMonitor) SetTickerFactory(factory storageTickerFactory) {
	if factory != nil {
		m.ticker = factory
	}
}
