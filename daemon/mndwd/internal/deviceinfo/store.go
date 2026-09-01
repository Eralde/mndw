package deviceinfo

import (
	"context"
	"errors"
	"sync"
	"time"
)

const defaultCacheTTL = time.Hour

type StoreOptions struct {
	TTL time.Duration
	Now func() time.Time
}

type Store struct {
	fetcher Fetcher
	ttl     time.Duration
	now     func() time.Time

	mu       sync.Mutex
	cached   *Snapshot
	cachedAt time.Time
}

func NewStore(fetcher Fetcher, options StoreOptions) *Store {
	ttl := options.TTL

	if ttl <= 0 {
		ttl = defaultCacheTTL
	}

	now := options.Now

	if now == nil {
		now = time.Now
	}

	return &Store{fetcher: fetcher, ttl: ttl, now: now}
}

func (s *Store) Get(ctx context.Context, cookie string) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}

	s.mu.Lock()

	defer s.mu.Unlock()

	if s.cached != nil && s.now().Before(s.cachedAt.Add(s.ttl)) {
		return cloneSnapshot(*s.cached), nil
	}

	if s.fetcher == nil {
		return Snapshot{}, errors.New("device-info fetcher is unavailable")
	}

	snapshot, err := s.fetcher.Fetch(ctx, cookie)
	if err != nil {
		return Snapshot{}, err
	}

	copy := cloneSnapshot(snapshot)
	s.cached = &copy
	s.cachedAt = s.now()

	return cloneSnapshot(copy), nil
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	copy := emptySnapshot()
	copy.Switchports.List = append(copy.Switchports.List, snapshot.Switchports.List...)
	copy.Switchports.Layout = make([][]string, len(snapshot.Switchports.Layout))

	for index, row := range snapshot.Switchports.Layout {
		copy.Switchports.Layout[index] = append([]string{}, row...)
	}

	copy.Switchports.HasPortStats = snapshot.Switchports.HasPortStats
	copy.USBPortCount = snapshot.USBPortCount

	return copy
}
