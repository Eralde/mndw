package backend

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/manifest"
	"mndwd/internal/registry"
)

func TestRuntimeCallerPathsSerialize(t *testing.T) {
	tests := []struct {
		name      string
		operation func(*RuntimeImpl, context.Context, string, *registry.Plugin) error
		wantError bool
	}{
		{name: "activate", operation: func(runtime *RuntimeImpl, ctx context.Context, _ string, plugin *registry.Plugin) error {
			return runtime.Activate(ctx, plugin)
		}, wantError: true},
		{name: "deactivate", operation: func(runtime *RuntimeImpl, ctx context.Context, pluginID string, _ *registry.Plugin) error {
			return runtime.Deactivate(ctx, pluginID)
		}},
		{name: "restart", operation: func(runtime *RuntimeImpl, ctx context.Context, pluginID string, _ *registry.Plugin) error {
			return runtime.Restart(ctx, pluginID)
		}, wantError: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			var firstCall atomic.Bool
			gates := NewActivationGateRegistry()

			gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(string) bool {
				if firstCall.CompareAndSwap(false, true) {
					close(entered)
					<-release
				}

				return true
			}))

			runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), ActivationGates: gates})
			plugin := unsupportedServicePlugin(t, "serialized", []string{manifest.PersistentRCISessionReadPermission})
			reconcileDone := make(chan struct{})

			go func() {
				runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
				close(reconcileDone)
			}()

			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("Reconcile did not reach activation gate")
			}

			operationDone := make(chan error, 1)

			go func() {
				operationDone <- test.operation(runtime, context.Background(), plugin.Name, plugin)
			}()

			select {
			case err := <-operationDone:
				t.Fatalf("%s completed while Reconcile held the pass: %v", test.name, err)
			case <-time.After(50 * time.Millisecond):
			}

			close(release)

			select {
			case <-reconcileDone:
			case <-time.After(time.Second):
				t.Fatal("Reconcile did not finish after releasing gate")
			}

			select {
			case err := <-operationDone:
				if (err != nil) != test.wantError {
					t.Fatalf("%s result = %v, wantError=%v", test.name, err, test.wantError)
				}
			case <-time.After(time.Second):
				t.Fatalf("%s remained blocked after Reconcile", test.name)
			}
		})
	}
}

func TestBackgroundStaleSpecConvergesOnFullReconcile(t *testing.T) {
	var gateState atomic.Bool
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(string) bool {
		return gateState.Load()
	}))

	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), ActivationGates: gates})
	plugin := unsupportedServicePlugin(t, "stale", []string{manifest.PersistentRCISessionReadPermission})

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})

	gateState.Store(true)

	spec := ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         "backend/server",
		ProtocolVersion: 2,
		Enabled:         true,
	}

	runtime.supervisor.mu.Lock()

	runtime.supervisor.desired[plugin.Name] = spec
	runtime.supervisor.services[plugin.Name] = &serviceRecord{
		spec:   spec,
		status: RuntimeStatus{State: StateCapacityBlocked},
	}

	runtime.supervisor.mu.Unlock()

	runtime.supervisor.promoteBlocked()

	runtime.supervisor.mu.Lock()

	resurrected, exists := runtime.supervisor.desired[plugin.Name]

	runtime.supervisor.mu.Unlock()

	if !exists || !resurrected.Enabled {
		t.Fatal("background stale start did not reproduce Enabled=true resurrection")
	}

	gateState.Store(false)
	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})

	if status := runtime.Status(plugin.Name); status.State != StateStopped {
		t.Fatalf("later full reconcile state = %q, want stopped", status.State)
	}

	runtime.supervisor.mu.Lock()

	converged, exists := runtime.supervisor.desired[plugin.Name]

	runtime.supervisor.mu.Unlock()

	if exists && converged.Enabled {
		t.Fatal("later full reconcile retained stale enabled spec")
	}
}

func TestRuntimeMutexCoversReadinessProbe(t *testing.T) {
	root := t.TempDir()
	pluginDir := filepath.Join(root, "plugin")
	commandPath := filepath.Join(pluginDir, "backend", "stall.sh")

	if err := os.MkdirAll(filepath.Dir(commandPath), 0o700); err != nil {
		t.Fatalf("create service command directory: %v", err)
	}

	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\nsleep 10\n"), 0o700); err != nil {
		t.Fatalf("write service command: %v", err)
	}

	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Supervisor: SupervisorConfig{
			ReadinessTimeout: time.Second,
			StopTimeout:      time.Second,
			FinalReapTimeout: time.Second,
		},
	})
	plugin := testServicePlugin(t, "slow", nil, "backend/stall.sh", true)
	plugin.Dir = pluginDir

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	reconcileDone := make(chan struct{})

	go func() {
		runtime.Reconcile(ctx, []*registry.Plugin{plugin})
		close(reconcileDone)
	}()

	deadline := time.After(time.Second)

	for runtime.Status(plugin.Name).State != StateStarting {
		select {
		case <-deadline:
			t.Fatalf("service never entered readiness probe; status=%q", runtime.Status(plugin.Name).State)
		default:
			time.Sleep(time.Millisecond)
		}
	}

	operationStarted := make(chan struct{})
	operationDone := make(chan error, 1)

	go func() {
		close(operationStarted)

		operationDone <- runtime.Deactivate(context.Background(), plugin.Name)
	}()

	<-operationStarted

	select {
	case err := <-operationDone:
		t.Fatalf("Deactivate completed during readiness probe: %v", err)
	default:
	}

	cancel()

	select {
	case <-reconcileDone:
	case <-time.After(time.Second):
		t.Fatal("Reconcile did not finish after readiness context cancellation")
	}

	if err := <-operationDone; err != nil {
		t.Fatalf("Deactivate after readiness probe = %v", err)
	}

	if status := runtime.Status(plugin.Name); status.State != StateStopped {
		t.Fatalf("service state after Deactivate = %q, want stopped", status.State)
	}
}

func TestRuntimeRestartWaitsForFullReconcile(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var firstCall atomic.Bool
	gates := NewActivationGateRegistry()

	gates.Register(manifest.PersistentRCISessionReadPermission, ActivationGateFunc(func(string) bool {
		if firstCall.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}

		return true
	}))

	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), ActivationGates: gates})
	plugin := unsupportedServicePlugin(t, "restart", []string{manifest.PersistentRCISessionReadPermission})
	spec := ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         "backend/server",
		ProtocolVersion: 2,
		Enabled:         true,
	}

	runtime.supervisor.mu.Lock()

	runtime.supervisor.desired[plugin.Name] = spec
	runtime.supervisor.services[plugin.Name] = &serviceRecord{spec: spec, status: RuntimeStatus{State: StateStopped}}

	runtime.supervisor.mu.Unlock()

	reconcileDone := make(chan struct{})

	go func() {
		runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
		close(reconcileDone)
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Reconcile did not reach activation gate")
	}

	restartDone := make(chan error, 1)

	go func() {
		restartDone <- runtime.Restart(context.Background(), plugin.Name)
	}()

	select {
	case err := <-restartDone:
		t.Fatalf("Restart completed while Reconcile held the mutex: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(release)

	select {
	case <-reconcileDone:
	case <-time.After(time.Second):
		t.Fatal("Reconcile did not finish after releasing gate")
	}

	if err := <-restartDone; err == nil {
		t.Fatal("Restart succeeded with intentionally unsupported service protocol")
	}

	if status := runtime.Status(plugin.Name); status.RestartCount != 1 {
		t.Fatalf("restart count = %d, want 1", status.RestartCount)
	}
}

func unsupportedServicePlugin(t *testing.T, name string, permissions []string) *registry.Plugin {
	t.Helper()

	plugin := testServicePlugin(t, name, permissions, "backend/server", true)
	protocol := 2
	plugin.Manifest.Backend.ProtocolVersion = &protocol

	return plugin
}
