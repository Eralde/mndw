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
