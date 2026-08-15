//go:build darwin || linux

package backend

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSupervisorStartIncompatibleStopsExistingRuntimeAndRestampsProtocol(t *testing.T) {
	runtimeRoot, err := os.MkdirTemp("", "mndw-supervisor-")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(runtimeRoot) })

	probePath := filepath.Join(runtimeRoot, "probe.sock")
	listener, err := net.Listen("unix", probePath)
	if err != nil {
		t.Skipf("sandbox disallows Unix listeners: %v", err)
	}

	_ = listener.Close()
	_ = os.Remove(probePath)

	pluginDir := t.TempDir()
	serviceBinary := filepath.Join(pluginDir, "backend", "service-helper")

	if err := os.MkdirAll(filepath.Dir(serviceBinary), 0o755); err != nil {
		t.Fatal(err)
	}

	buildServiceHelper(t, serviceBinary)

	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        runtimeRoot,
		Limits:             Limits{MaxSupervisedServices: 1},
		SupportedProtocols: []int{1},
		ReadinessTimeout:   2 * time.Second,
		StopTimeout:        100 * time.Millisecond,
		FinalReapTimeout:   100 * time.Millisecond,
	})
	compatible := ServiceSpec{
		PluginID:        "svc",
		Dir:             pluginDir,
		Command:         "backend/service-helper",
		ProtocolVersion: 1,
		Enabled:         true,
	}

	if err := supervisor.Start(context.Background(), compatible); err != nil {
		t.Fatalf("start compatible service: %v; status=%+v", err, supervisor.Status("svc"))
	}

	t.Cleanup(func() { _ = supervisor.Forget(context.Background(), "svc") })

	if status := supervisor.Status("svc"); status.State != StateReady {
		t.Fatalf("initial state = %q, want ready", status.State)
	}

	_, services, _ := supervisor.admission.Snapshot()

	if services != 1 {
		t.Fatalf("initial service reservations = %d, want 1", services)
	}

	incompatible := compatible
	incompatible.ProtocolVersion = 2

	if err := supervisor.Start(context.Background(), incompatible); err == nil {
		t.Fatal("incompatible update succeeded")
	}

	status := supervisor.Status("svc")

	if status.State != StateStopped || status.RequiredProtocol != 2 || status.Compatible == nil || *status.Compatible {
		t.Fatalf("status after incompatible update = %+v", status)
	}

	if len(status.SupportedProtocols) != 1 || status.SupportedProtocols[0] != 1 {
		t.Fatalf("supported protocols = %#v, want [1]", status.SupportedProtocols)
	}

	_, services, _ = supervisor.admission.Snapshot()

	if services != 0 {
		t.Fatalf("service reservations after stop = %d, want 0", services)
	}

	paths, err := NewRuntimePaths(runtimeRoot, "svc")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.BackendSocket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backend socket after stop: %v", err)
	}

	if _, err := os.Stat(paths.ServiceLease); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("service lease after stop: %v", err)
	}
}
