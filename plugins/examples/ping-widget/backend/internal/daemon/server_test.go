package daemon

import (
	"testing"

	"ping-widget/internal/model"
)

func TestNewServiceStateStartsRunning(t *testing.T) {
	state := NewServiceState(nil, nil)

	if !state.Running() {
		t.Fatal("new service state is not running")
	}
}

func TestRunPingCycleSkipsTargetsWhenStopped(t *testing.T) {
	state := NewServiceState([]model.Host{{IP: "192.0.2.1"}}, nil)

	state.SetRunning(false)

	server := &Server{state: state}
	calls := 0

	server.runPingCycle(func(string) model.Sample {
		calls++

		return model.Sample{Success: true, LatencyMs: 1}
	})

	if calls != 0 || len(state.Stats()[0].UpdatedAt) != 0 {
		t.Fatalf("stopped cycle ran: calls=%d stats=%#v", calls, state.Stats())
	}
}

func TestRunPingCycleRecordsTargetsWhenRunning(t *testing.T) {
	state := NewServiceState([]model.Host{{IP: "192.0.2.1"}}, nil)
	server := &Server{state: state}

	server.runPingCycle(func(string) model.Sample {
		return model.Sample{Success: true, LatencyMs: 1, At: "now"}
	})

	if got := state.Stats()[0].SampleCount; got != 1 {
		t.Fatalf("sample count = %d, want 1", got)
	}
}

func TestStatsComputesLatencySummary(t *testing.T) {
	state := NewServiceState(
		[]model.Host{{IP: "192.0.2.1", Name: "gateway"}},
		map[string][]model.Sample{
			"192.0.2.1": {
				{Success: true, LatencyMs: 3, At: "first"},
				{Success: true, LatencyMs: 1, At: "second"},
				{Success: false, At: "third"},
				{Success: true, LatencyMs: 2, At: "fourth"},
			},
		},
	)

	stats := state.Stats()

	if len(stats) != 1 {
		t.Fatalf("stats = %#v", stats)
	}

	got := stats[0]

	if got.AvgMs != 2 || got.MedianMs != 2 || got.MinMs != 1 || got.MaxMs != 3 || got.LossPercent != 25 {
		t.Fatalf("stats = %#v", got)
	}

	if got.LastMs != 2 || got.UpdatedAt != "fourth" {
		t.Fatalf("last sample = %#v", got)
	}
}
