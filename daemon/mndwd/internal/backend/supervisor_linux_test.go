//go:build linux

package backend

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSupervisorRefreshesServiceLeaseAfterWrapperExec(t *testing.T) {
	runtimeRoot := shortUnixSocketDir(t)
	pluginDir := t.TempDir()
	serviceBinary := filepath.Join(pluginDir, "backend", "service-helper")

	if err := os.MkdirAll(filepath.Dir(serviceBinary), 0o755); err != nil {
		t.Fatal(err)
	}

	buildServiceHelper(t, serviceBinary)

	wrapper := filepath.Join(pluginDir, "backend", "wrapper.sh")

	if err := os.WriteFile(
		wrapper,
		[]byte("#!/bin/sh\nwhile [ ! -f \"$MNDW_PLUGIN_RUNTIME_DIR/service.lease\" ]; do sleep 0.01; done\nexec ./backend/service-helper\n"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}

	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        runtimeRoot,
		SupportedProtocols: []int{1},
		Limits:             Limits{MaxSupervisedServices: 1},
		ReadinessTimeout:   2 * time.Second,
		StopTimeout:        2 * time.Second,
		FinalReapTimeout:   time.Second,
		Logger:             backendTestLogger(),
	})
	spec := ServiceSpec{
		PluginID:        "wrapper",
		Dir:             pluginDir,
		Command:         "backend/wrapper.sh",
		ProtocolVersion: 1,
		Enabled:         true,
	}

	if err := startSupervisorForTest(supervisor, spec); err != nil {
		t.Fatalf("start wrapper service: %v; status=%+v", err, supervisor.Status(spec.PluginID))
	}

	t.Cleanup(func() {
		if err := stopSupervisorForTest(supervisor, spec.PluginID); err != nil {
			t.Errorf("stop wrapper service: %v", err)
		}
	})

	if status := supervisor.Status(spec.PluginID); status.State != StateReady {
		t.Fatalf("service state = %q, want ready", status.State)
	}

	paths, err := NewRuntimePaths(runtimeRoot, spec.PluginID)
	if err != nil {
		t.Fatal(err)
	}

	lease, err := ReadServiceLease(paths.ServiceLease)
	if err != nil {
		t.Fatalf("read ready service lease: %v", err)
	}

	resolvedBinary, err := filepath.EvalSymlinks(serviceBinary)
	if err != nil {
		t.Fatalf("resolve backend executable: %v", err)
	}

	if lease.ExecutablePath != resolvedBinary {
		t.Fatalf("lease executable = %q, want backend %q", lease.ExecutablePath, resolvedBinary)
	}

	matched, err := validateServiceLease(lease, systemProcessReader{})
	if err != nil || !matched {
		t.Fatalf("ready service lease validation = %v, %v; want true, nil", matched, err)
	}
}
