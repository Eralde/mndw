package backend

import (
	"context"
	"testing"

	"mndwd/internal/manifest"
	"mndwd/internal/registry"
)

func TestRuntimeLimitsExposeConfiguredCapacityWithoutProcessDetails(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxConcurrentExecTotal: 8, MaxConcurrentExecPerPlugin: 4, MaxSupervisedServices: 8}})
	snapshot := runtime.Limits()

	if snapshot.MaxConcurrentExecTotal != 8 || snapshot.MaxConcurrentExecPerPlugin != 4 || snapshot.MaxSupervisedServices != 8 {
		t.Fatalf("limits = %#v", snapshot)
	}

	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeIgnoresPluginsWithoutV3ServiceBackend(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

	runtime.Reconcile(context.Background(), []*registry.Plugin{{Name: "no-backend", Manifest: nil}})

	if got := runtime.Status("no-backend").State; got != StateStopped {
		t.Fatalf("no-backend status = %q", got)
	}
}

func TestNewRuntimeInitializesSupervisorClock(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

	if runtime.supervisor.cfg.Now == nil {
		t.Fatal("supervisor clock is nil")
	}
}

func TestRuntimeGatedServiceReservesNoSlotAndActivateDoesNotSpawn(t *testing.T) {
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(string) bool { return false }))

	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot:     t.TempDir(),
		Limits:          Limits{MaxSupervisedServices: 1},
		ActivationGates: gates,
	})
	plugin := testServicePlugin(t, "gated", []string{manifest.PersistentRCISessionReadPermission}, "backend/does-not-exist", true)

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})

	if got := runtime.Limits().ReservedServices; got != 0 {
		t.Fatalf("reserved services = %d, want 0", got)
	}

	if got := runtime.Status("gated").State; got != StateStopped {
		t.Fatalf("gated status = %q, want stopped", got)
	}

	if err := runtime.Activate(context.Background(), plugin); err != nil {
		t.Fatalf("gated Activate() = %v, want nil", err)
	}
}
