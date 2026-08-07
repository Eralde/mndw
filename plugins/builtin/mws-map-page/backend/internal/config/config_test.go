package config

import (
	"testing"
	"time"
)

func TestParseAppliesRuntimeAndTimeoutOverrides(t *testing.T) {
	environ := func(name string) string {
		values := map[string]string{
			"MNDW_MWSD_RUNTIME_DIR": "/tmp/mwsd",
		}
		return values[name]
	}
	cfg, err := Parse([]string{"--auth-timeout=17s", "--operation-timeout=3s"}, environ)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeDir != "/tmp/mwsd" || cfg.AuthOperation != 17*time.Second || cfg.Operation != 3*time.Second {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestParsePrefersGenericPluginRuntimeDir(t *testing.T) {
	environ := func(name string) string {
		values := map[string]string{
			"MNDW_PLUGIN_RUNTIME_DIR": "/tmp/generic-plugin",
			"MNDW_MWSD_RUNTIME_DIR":   "/tmp/legacy-mwsd",
		}
		return values[name]
	}

	cfg, err := Parse(nil, environ)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeDir != "/tmp/generic-plugin" {
		t.Fatalf("runtime dir = %q, want generic plugin runtime dir", cfg.RuntimeDir)
	}
}

func TestParseRejectsNonPositiveLimits(t *testing.T) {
	if _, err := Parse([]string{"--max-request-bytes=0"}, func(string) string { return "" }); err == nil {
		t.Fatal("Parse() error = nil")
	}
}
