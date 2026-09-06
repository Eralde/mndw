package events

import (
	"context"
	"log/slog"
	"time"

	"golang.org/x/sys/unix"
	contractEvents "mndw.local/contracts/events"
)

const (
	StorageLowThreshold  uint64 = 5 * 1024 * 1024
	StorageCheckInterval        = 30 * time.Second
)

type StorageStatFunc func(path string) (availableBytes uint64, err error)
type StorageTicker interface {
	C() <-chan time.Time
	Stop()
}
type StorageTickerFactory func(time.Duration) StorageTicker

type StorageMonitor struct {
	path      string
	stat      StorageStatFunc
	ticker    StorageTickerFactory
	publisher *InternalPublisher
	logger    *slog.Logger
	low       bool
	mu        chan struct{}
}

func NewStorageMonitor(path string, stat StorageStatFunc, publisher *InternalPublisher, logger *slog.Logger) *StorageMonitor {
	if path == "" {
		path = "/opt"
	}

	if stat == nil {
		stat = statAvailable
	}

	if logger == nil {
		logger = slog.Default()
	}

	return &StorageMonitor{
		path:      path,
		stat:      stat,
		publisher: publisher,
		logger:    logger,
		mu:        make(chan struct{}, 1),
		ticker: func(interval time.Duration) StorageTicker {
			return realStorageTicker{Ticker: time.NewTicker(interval)}
		},
	}
}

type realStorageTicker struct{ *time.Ticker }

func (t realStorageTicker) C() <-chan time.Time { return t.Ticker.C }

func (m *StorageMonitor) SetTickerFactory(factory StorageTickerFactory) {
	if factory != nil {
		m.ticker = factory
	}
}

func (m *StorageMonitor) Check() {
	available, err := m.stat(m.path)
	if err != nil {
		m.logger.Warn("storage monitor statfs failed", "path", m.path, "error", err)

		return
	}

	m.mu <- struct{}{}

	defer func() { <-m.mu }()

	if available < StorageLowThreshold {
		if m.low {
			return
		}

		m.low = true

		if m.publisher != nil {
			if err := m.publisher.Publish(contractEvents.TopicStorageLow, map[string]any{
				"path":            "/opt",
				"available_bytes": available,
				"threshold_bytes": StorageLowThreshold,
			}); err != nil {
				m.logger.Warn("storage.low publish failed", "error", err)
			}
		}

		return
	}

	if available > StorageLowThreshold {
		m.low = false
	}
}

func (m *StorageMonitor) Run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}

	m.Check()

	ticker := m.ticker(StorageCheckInterval)

	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C():
			m.Check()
		}
	}
}

func statAvailable(path string) (uint64, error) {
	var stat unix.Statfs_t

	if err := unix.Statfs(path, &stat); err != nil {
		return 0, err
	}

	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
