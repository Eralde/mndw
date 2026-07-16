package readiness

import (
	"sync"
	"testing"
)

func TestTrackerLifecycle(t *testing.T) {
	tr := New()

	if _, ok := tr.Get("ttyd-widget"); ok {
		t.Fatal("new tracker must report no state (ready) for unknown plugins")
	}

	tr.Set("ttyd-widget", StateInstalling)
	if s, ok := tr.Get("ttyd-widget"); !ok || s != StateInstalling {
		t.Fatalf("Get after Set(installing) = (%q, %v), want (installing, true)", s, ok)
	}

	tr.Set("ttyd-widget", StateFailed)
	if s, _ := tr.Get("ttyd-widget"); s != StateFailed {
		t.Fatalf("Get after Set(failed) = %q, want failed", s)
	}

	tr.MarkReady("ttyd-widget")
	if _, ok := tr.Get("ttyd-widget"); ok {
		t.Fatal("MarkReady must delete the entry (ready = absence)")
	}
}

func TestTrackerMarkReadyUnknownIsNoop(t *testing.T) {
	tr := New()
	tr.MarkReady("never-seen")
}

// TestTrackerConcurrentAccess exists to fail under `go test -race` if the tracker
// is unsynchronized; it asserts nothing beyond absence of races/panics.
func TestTrackerConcurrentAccess(t *testing.T) {
	tr := New()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				tr.Set("p", StateInstalling)
				tr.Get("p")
				tr.MarkReady("p")
			}
		}()
	}
	wg.Wait()
}
