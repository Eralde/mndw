package main

import (
	"path/filepath"
	"testing"
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
