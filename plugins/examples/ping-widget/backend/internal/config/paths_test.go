package config

import "testing"

func TestBackendSocketPathUsesSupervisorEnvironment(t *testing.T) {
	t.Setenv("MNDW_BACKEND_SOCKET", "/tmp/generic-plugin/backend.sock")

	if got := BackendSocketPath(); got != "/tmp/generic-plugin/backend.sock" {
		t.Fatalf("backend socket path = %q", got)
	}
}
