package telemetry

import (
	"runtime"
	"sync"
	"time"
)

// durationStats aggregates timings between periodic perf reports so frequent
// operations are measured without one log line each.
type durationStats struct {
	mu    sync.Mutex
	count int
	total time.Duration
	max   time.Duration
}

// durationSummary is one drained reporting window.
type durationSummary struct {
	Count int
	Mean  time.Duration
	Max   time.Duration
}

func (s *durationStats) observe(d time.Duration) {
	s.mu.Lock()

	defer s.mu.Unlock()

	s.count++
	s.total += d

	if d > s.max {
		s.max = d
	}
}

// drain returns the window since the previous drain and starts a new one.
func (s *durationStats) drain() durationSummary {
	s.mu.Lock()

	defer s.mu.Unlock()

	summary := durationSummary{Count: s.count, Max: s.max}

	if s.count > 0 {
		summary.Mean = s.total / time.Duration(s.count)
	}

	s.count = 0
	s.total = 0
	s.max = 0

	return summary
}

// durationMs renders a duration with microsecond resolution for logs.
func durationMs(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

// heapAllocBytes reports live heap bytes. collect runs a full GC first so the
// value excludes garbage; use it only on rare paths such as startup.
func heapAllocBytes(collect bool) uint64 {
	if collect {
		runtime.GC()
	}

	var stats runtime.MemStats

	runtime.ReadMemStats(&stats)

	return stats.HeapAlloc
}
