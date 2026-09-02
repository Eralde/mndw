package deviceinfo

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeFetcher struct {
	mu       sync.Mutex
	calls    int
	snapshot Snapshot
	err      error
	started  chan struct{}
	release  chan struct{}
}

func (f *fakeFetcher) Fetch(context.Context, string) (Snapshot, error) {
	f.mu.Lock()

	f.calls++

	if f.started != nil {
		select {
		case <-f.started:
		default:
			close(f.started)
		}
	}

	releaseCh := f.release
	snapshot, err := f.snapshot, f.err

	f.mu.Unlock()

	if releaseCh != nil {
		<-releaseCh
	}

	return snapshot, err
}

func (f *fakeFetcher) callCount() int {
	f.mu.Lock()

	defer f.mu.Unlock()

	return f.calls
}

func TestStoreCachesSuccessfulFetchUntilTTL(t *testing.T) {
	now := time.Unix(100, 0)
	fetcher := &fakeFetcher{snapshot: Snapshot{Switchports: Switchports{List: []Switchport{{ID: "WAN"}}}}}
	store := NewStore(fetcher, StoreOptions{TTL: time.Hour, Now: func() time.Time { return now }})

	first, err := store.Get(context.Background(), "")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}

	now = now.Add(time.Hour)
	second, err := store.Get(context.Background(), "")
	if err != nil {
		t.Fatalf("expired Get: %v", err)
	}

	if fetcher.callCount() != 2 || len(first.Switchports.List) != 1 || len(second.Switchports.List) != 1 {
		t.Fatalf("calls = %d, first = %+v, second = %+v, want two fetches", fetcher.callCount(), first, second)
	}
}

func TestStoreDoesNotCacheFailures(t *testing.T) {
	fetcher := &fakeFetcher{err: errors.New("device down")}
	store := NewStore(fetcher, StoreOptions{Now: time.Now})

	if _, err := store.Get(context.Background(), ""); err == nil {
		t.Fatal("first Get returned nil error")
	}

	if _, err := store.Get(context.Background(), ""); err == nil {
		t.Fatal("second Get returned nil error")
	}

	if fetcher.callCount() != 2 {
		t.Fatalf("fetch calls = %d, want retry after failure", fetcher.callCount())
	}
}

func TestStoreSerializesConcurrentFirstFetches(t *testing.T) {
	started := make(chan struct{})
	continueCh := make(chan struct{})
	fetcher := &fakeFetcher{snapshot: Snapshot{Switchports: Switchports{List: []Switchport{{ID: "LAN1"}}}}, started: started, release: continueCh}
	store := NewStore(fetcher, StoreOptions{Now: time.Now})

	results := make(chan error, 2)

	go func() {
		_, err := store.Get(context.Background(), "")
		results <- err
	}()

	<-started

	go func() {
		_, err := store.Get(context.Background(), "")
		results <- err
	}()

	close(continueCh)

	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("concurrent Get: %v", err)
		}
	}

	if fetcher.callCount() != 1 {
		t.Fatalf("fetch calls = %d, want one", fetcher.callCount())
	}
}
