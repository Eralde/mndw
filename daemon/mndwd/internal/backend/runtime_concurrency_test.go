package backend

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mndwd/internal/registry"
)

func TestLifecycleRunsForDifferentPluginsDoNotSerialize(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)

	go func() {
		firstDone <- runtime.ExecuteLifecycle("first", OpUpdating, IntentRun,
			func(context.Context, LifecycleControl) error {
				close(firstEntered)
				<-releaseFirst

				return nil
			})
	}()

	<-firstEntered

	if err := runtime.ExecuteLifecycle("second", OpInstalling, IntentRun,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatalf("independent lifecycle = %v", err)
	}

	close(releaseFirst)

	if err := <-firstDone; err != nil {
		t.Fatalf("first lifecycle = %v", err)
	}
}

func TestReconcileStartupFailureTerminalizes(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	plugin := testServicePlugin(t, "missing", nil, "backend/does-not-exist", true)

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForLifecycleAttempt(t, runtime, plugin.Name)

	if got := runtime.operationOf(plugin.Name); got != OpNone {
		t.Fatalf("failed startup operation = %v, want OpNone", got)
	}

	if got := runtime.intentOf(plugin.Name); got != IntentRun {
		t.Fatalf("failed startup intent = %v, want IntentRun", got)
	}

	if got := runtime.Status(plugin.Name).State; got != StateBackoff {
		t.Fatalf("failed startup state = %q, want backoff", got)
	}
}

func TestDeleteWinsOverSlowStartupIntegration(t *testing.T) {
	runtime, plugin := slowStartupRuntime(t, "slow")

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForOperation(t, runtime, plugin.Name, OpStarting)

	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle(plugin.Name, OpDeleting, IntentRemove,
			func(_ context.Context, control LifecycleControl) error { return control.StopService() })
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("delete = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("delete blocked behind slow startup")
	}

	if got := runtime.Status(plugin.Name).State; got != StateStopped {
		t.Fatalf("service after delete = %q, want stopped", got)
	}
}

func TestRepeatedReconcileDoesNotDuplicateStartingRun(t *testing.T) {
	runtime, plugin := slowStartupRuntime(t, "repeat")

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForOperation(t, runtime, plugin.Name, OpStarting)

	firstGeneration := runtime.generationOf(plugin.Name)

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})

	if got := runtime.generationOf(plugin.Name); got != firstGeneration {
		t.Fatalf("generation after repeated reconcile = %d, want %d", got, firstGeneration)
	}

	if err := runtime.ExecuteLifecycle(plugin.Name, OpDeleting, IntentRemove,
		func(_ context.Context, control LifecycleControl) error { return control.StopService() }); err != nil {
		t.Fatalf("cleanup delete = %v", err)
	}
}

func TestReconcileChangedSpecRestartsExistingService(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	plugin := testServicePlugin(t, "changed", nil, "backend/new-missing", true)
	oldSpec := ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         "backend/old",
		ProtocolVersion: 1,
		Enabled:         true,
	}

	runtime.supervisor.withLock(func() {
		runtime.supervisor.coord.records[plugin.Name] = &transition{intent: IntentRun, operation: OpNone}
		runtime.supervisor.desired[plugin.Name] = oldSpec
		runtime.supervisor.services[plugin.Name] = &serviceRecord{
			spec:   oldSpec,
			status: RuntimeStatus{State: StateReady},
		}
	})

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForLifecycleAttempt(t, runtime, plugin.Name)

	if got := runtime.Status(plugin.Name).State; got != StateBackoff {
		t.Fatalf("changed service state = %q, want restart attempt/backoff", got)
	}
}

func slowStartupRuntime(t *testing.T, pluginID string) (*RuntimeImpl, *registry.Plugin) {
	t.Helper()

	root := t.TempDir()
	pluginDir := filepath.Join(root, "plugin")
	commandPath := filepath.Join(pluginDir, "backend", "stall.sh")

	if err := os.MkdirAll(filepath.Dir(commandPath), 0o700); err != nil {
		t.Fatalf("create command directory: %v", err)
	}

	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\nsleep 10\n"), 0o700); err != nil {
		t.Fatalf("write service command: %v", err)
	}

	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Supervisor: SupervisorConfig{
			ReadinessTimeout: 10 * time.Second,
			StopTimeout:      500 * time.Millisecond,
			FinalReapTimeout: 500 * time.Millisecond,
		},
	})
	plugin := testServicePlugin(t, pluginID, nil, "backend/stall.sh", true)
	plugin.Dir = pluginDir

	return runtime, plugin
}

func waitForLifecycleAttempt(t *testing.T, runtime *RuntimeImpl, pluginID string) {
	t.Helper()

	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(time.Millisecond)

	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			t.Fatalf("startup did not finish: op=%v state=%q", runtime.operationOf(pluginID), runtime.Status(pluginID).State)
		case <-ticker.C:
			if runtime.operationOf(pluginID) == OpNone && runtime.Status(pluginID).State == StateBackoff {
				return
			}
		}
	}
}
