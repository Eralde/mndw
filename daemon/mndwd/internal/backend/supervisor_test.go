package backend

import (
	"context"
	"errors"
	"testing"
	"time"

	"mndw.local/shared/ptr"
)

func TestFailureTransitionResetsOnlyAfterHealthyObservation(t *testing.T) {
	now := time.Date(2026, time.August, 10, 12, 0, 0, 0, time.UTC)
	supervisor := NewSupervisor(SupervisorConfig{Now: func() time.Time { return now }, RuntimeRoot: t.TempDir()})
	supervisor.services["demo"] = &serviceRecord{status: RuntimeStatus{State: StateReady, ConsecutiveFailures: 4, StartedAt: ptr.To(now.Add(-61 * time.Second))}}

	done := make(chan error, 1)
	done <- errors.New("process exited")
	supervisor.observeExit("demo", done)

	status := supervisor.Status("demo")
	if status.ConsecutiveFailures != 1 {
		t.Fatalf("healthy-exit failure count = %d, want 1", status.ConsecutiveFailures)
	}
	if status.LastExit != "exited" || status.LastError != "process exited" {
		t.Fatalf("healthy-exit status = %+v", status)
	}
}

func TestFailureTransitionDoesNotResetStartFailures(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{RuntimeRoot: t.TempDir()})
	supervisor.services["demo"] = &serviceRecord{status: RuntimeStatus{State: StateStarting, ConsecutiveFailures: 4}}

	supervisor.failStart("demo", errors.New("start failed"))

	status := supervisor.Status("demo")
	if status.ConsecutiveFailures != 5 || status.State != StateFailed {
		t.Fatalf("start-failure status = %+v", status)
	}
}

func TestSupervisorStartsWithStoppedStatusAndReportsCapacity(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}, SupportedProtocols: []int{1}})
	if got := supervisor.Status("missing").State; got != StateStopped {
		t.Fatalf("missing state = %q", got)
	}
	first, ok := supervisor.admission.TryReserveService("first")
	if !ok {
		t.Fatal("first service reservation rejected")
	}
	defer first.Release()
	if _, ok := supervisor.admission.TryReserveService("second"); ok {
		t.Fatal("second service reservation accepted")
	}
}

func TestSupervisorRecordsIncompatibleServiceWithoutStartingIt(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		SupportedProtocols: []int{1},
	})
	err := supervisor.Start(context.Background(), ServiceSpec{
		PluginID:        "incompatible",
		Dir:             t.TempDir(),
		Command:         "backend/server",
		ProtocolVersion: 2,
		Enabled:         true,
	})
	if err == nil {
		t.Fatal("incompatible service start succeeded")
	}
	status := supervisor.Status("incompatible")
	if status.State != StateStopped {
		t.Fatalf("incompatible service state = %q, want stopped", status.State)
	}
	if status.RequiredProtocol != 2 || status.Compatible == nil || *status.Compatible {
		t.Fatalf("incompatible service status = %+v", status)
	}
	if len(status.SupportedProtocols) != 1 || status.SupportedProtocols[0] != 1 {
		t.Fatalf("supported protocols = %#v, want [1]", status.SupportedProtocols)
	}
}

func TestWaitForProcessExitHasBoundedFinalReap(t *testing.T) {
	done := make(chan error)
	started := time.Now()

	if waitForProcessExit(done, 10*time.Millisecond) {
		t.Fatal("waitForProcessExit reported an exit for an open channel")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("waitForProcessExit took %s", elapsed)
	}
}
