package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestParseDefaultsPluginRuntimeRootInsideDataDir(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_ROOT", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.PluginRuntimeRoot, filepath.Join("/var/lib/mndw", "plugin-runtime"); got != want {
		t.Fatalf("plugin runtime root = %q, want %q", got, want)
	}
}

func TestParseDefaultsDiagnosticsLogFile(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DiagnosticsLogFile != "/opt/var/log/mndwd.log" {
		t.Fatalf("diagnostics log file = %q, want production default", cfg.DiagnosticsLogFile)
	}
}

func TestParseAcceptsDiagnosticsLogFileOverride(t *testing.T) {
	cfg, _, err := parseFlags([]string{
		"--dev",
		"--diagnostics-log-file", "/tmp/mndwd-test.log",
		"--data-dir", "/tmp/mndw-dev-data",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DiagnosticsLogFile != "/tmp/mndwd-test.log" {
		t.Fatalf("diagnostics log file = %q, want override", cfg.DiagnosticsLogFile)
	}
}

func TestParseAllowsPluginRuntimeRootEnvironmentOverride(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_ROOT", "/tmp/plugin-runtime")

	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.PluginRuntimeRoot != "/tmp/plugin-runtime" {
		t.Fatalf("plugin runtime root = %q, want environment override", cfg.PluginRuntimeRoot)
	}
}

func TestParseDefaultsPersistentSessionConfig(t *testing.T) {
	t.Setenv("MNDW_HOST_DEVICE", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.RCISessionStateDir, "/var/lib/mndw"; got != want {
		t.Fatalf("RCI session state dir = %q, want %q", got, want)
	}
	if got, want := cfg.ControllerURL, "http://127.0.0.1:79"; got != want {
		t.Fatalf("controller URL = %q, want %q", got, want)
	}
	if got, want := cfg.RCISessionKeyDir, "/opt/var/lib/mndw-secrets"; got != want {
		t.Fatalf("RCI session key dir = %q, want %q", got, want)
	}
	if got, want := cfg.RCISessionCiphertextFile(), "/var/lib/mndw/rci-session.enc"; got != want {
		t.Fatalf("RCI ciphertext file = %q, want %q", got, want)
	}
	if got, want := cfg.RCISessionKeyFile(), "/opt/var/lib/mndw-secrets/rci-session.key"; got != want {
		t.Fatalf("RCI key file = %q, want %q", got, want)
	}
	if cfg.RCIEnumerationTTL != 30*time.Second {
		t.Fatalf("RCI enumeration TTL = %s, want 30s", cfg.RCIEnumerationTTL)
	}
	if cfg.RCIProxyIdleTimeout != 2*time.Minute {
		t.Fatalf("RCI proxy idle timeout = %s, want 2m", cfg.RCIProxyIdleTimeout)
	}
	if cfg.RCIProxyOperationTimeout != cfg.ExecTimeout {
		t.Fatalf("RCI proxy operation timeout = %s, want exec timeout %s", cfg.RCIProxyOperationTimeout, cfg.ExecTimeout)
	}
	if cfg.RCIProxyMaxInflight != 8 {
		t.Fatalf("RCI proxy max inflight = %d, want 8", cfg.RCIProxyMaxInflight)
	}
	if cfg.RCIProxyMaxResponseBytes != 1<<20 {
		t.Fatalf("RCI proxy max response bytes = %d, want 1 MiB", cfg.RCIProxyMaxResponseBytes)
	}
}

func TestParseDevUsesHostDeviceAsControllerURL(t *testing.T) {
	t.Setenv("MNDW_HOST_DEVICE", "http://192.168.1.1")

	cfg, _, err := parseFlags([]string{"--dev", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ControllerURL != "http://192.168.1.1" {
		t.Fatalf("controller URL = %q, want host device", cfg.ControllerURL)
	}
}

func TestParseDevAcceptsExplicitHTTPControllerURL(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--controller-url", "http://192.168.1.1:80", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ControllerURL != "http://192.168.1.1:80" {
		t.Fatalf("controller URL = %q", cfg.ControllerURL)
	}
}

func TestParseDevAcceptsHTTPSControllerURL(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--controller-url", "https://controller.example", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ControllerURL != "https://controller.example" {
		t.Fatalf("controller URL = %q", cfg.ControllerURL)
	}
}

func TestParseRejectsMalformedControllerURL(t *testing.T) {
	for _, value := range []string{
		"not-a-url",
		"http://user:password@192.168.1.1",
		"http://192.168.1.1/rci",
		"http://192.168.1.1?token=secret",
	} {
		if _, _, err := parseFlags([]string{"--dev", "--controller-url", value}); err == nil {
			t.Fatalf("controller URL %q accepted", value)
		}
	}
}

func TestParseDevDefaultsPersistentSessionKeyDirectoryOutsideDataDir(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.RCISessionKeyDir, filepath.Join("/tmp", "rci-session-secrets"); got != want {
		t.Fatalf("dev RCI session key dir = %q, want %q", got, want)
	}
}

func TestParseRejectsProductionControllerURLOverride(t *testing.T) {
	_, _, err := parseFlags([]string{
		"--data-dir", "/var/lib/mndw",
		"--rci-session-state-dir", "/var/lib/mndw-rci",
		"--rci-session-key-dir", "/var/secure/mndw",
		"--controller-url", "http://192.168.1.1:80",
		"--rci-enumeration-ttl", "45s",
		"--rci-proxy-idle-timeout", "3m",
		"--rci-proxy-operation-timeout", "17s",
		"--rci-proxy-max-inflight", "4",
		"--rci-proxy-max-response-bytes", "2048",
	})
	if err == nil {
		t.Fatal("production controller override accepted")
	}
}

func TestParseRejectsInvalidPersistentSessionConfig(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "key directory nested in state", args: []string{"--data-dir", "/var/lib/mndw", "--rci-session-key-dir", "/var/lib/mndw/secrets"}},
		{name: "zero enumeration ttl", args: []string{"--rci-enumeration-ttl", "0s"}},
		{name: "negative idle timeout", args: []string{"--rci-proxy-idle-timeout", "-1s"}},
		{name: "zero inflight", args: []string{"--rci-proxy-max-inflight", "0"}},
		{name: "zero response limit", args: []string{"--rci-proxy-max-response-bytes", "0"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := parseFlags(test.args); err == nil {
				t.Fatal("parseFlags succeeded, want error")
			}
		})
	}
}
