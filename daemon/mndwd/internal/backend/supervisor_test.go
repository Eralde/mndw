package backend

import (
	"context"
	"testing"
	"time"
)

func TestNormalizeSupervisorConfigAppliesDefaults(t *testing.T) {
	now := func() time.Time { return time.Unix(123, 0) }
	cfg := normalizeSupervisorConfig(SupervisorConfig{Now: now})

	if cfg.Limits.MaxSupervisedServices != 8 {
		t.Fatalf("MaxSupervisedServices = %d, want 8", cfg.Limits.MaxSupervisedServices)
	}

	if cfg.ReadinessTimeout != 30*time.Second || cfg.StopTimeout != 10*time.Second || cfg.DiagnosticsTimeout != 2*time.Second || cfg.FinalReapTimeout != 2*time.Second {
		t.Fatalf("timeouts = %#v", cfg)
	}

	if cfg.Now == nil || cfg.Now() != now() {
		t.Fatal("injected Now was not preserved")
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
