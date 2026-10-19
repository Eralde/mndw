package telemetry

import (
	"testing"
	"time"
)

func TestDurationStatsDrainSummarizesAndResets(t *testing.T) {
	var stats durationStats

	if got := stats.drain(); got != (durationSummary{}) {
		t.Fatalf("empty drain = %+v", got)
	}

	stats.observe(2 * time.Millisecond)
	stats.observe(6 * time.Millisecond)
	stats.observe(4 * time.Millisecond)

	got := stats.drain()
	want := durationSummary{Count: 3, Mean: 4 * time.Millisecond, Max: 6 * time.Millisecond}

	if got != want {
		t.Fatalf("drain = %+v, want %+v", got, want)
	}

	if got := stats.drain(); got != (durationSummary{}) {
		t.Fatalf("drain after reset = %+v", got)
	}
}

func TestDurationMsKeepsMicroseconds(t *testing.T) {
	if got := durationMs(1500 * time.Microsecond); got != 1.5 {
		t.Fatalf("durationMs = %v, want 1.5", got)
	}
}
