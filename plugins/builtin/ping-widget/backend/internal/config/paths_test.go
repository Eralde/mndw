package config

import "testing"

func TestRuntimePathsPreferGenericPluginRuntimeDir(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_DIR", "/tmp/generic-plugin")

	if got, want := SocketPath(), "/tmp/generic-plugin/ping-widget.sock"; got != want {
		t.Fatalf("socket path = %q, want %q", got, want)
	}
	if got, want := PidFilePath(), "/tmp/generic-plugin/ping-widget.pid"; got != want {
		t.Fatalf("pid path = %q, want %q", got, want)
	}
}
