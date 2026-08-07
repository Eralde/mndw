package lifecycle

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagerInjectsPrivatePluginRuntimeDir(t *testing.T) {
	pluginDir := t.TempDir()
	runtimeRoot := t.TempDir()
	envFile := filepath.Join(pluginDir, "runtime-env")
	hook := filepath.Join(pluginDir, "start.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf '%s' \"$MNDW_PLUGIN_RUNTIME_DIR\" > runtime-env\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := New(logger, Options{RuntimeRoot: runtimeRoot})
	if err := manager.Start("example-plugin", pluginDir, "start.sh"); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.TrimSpace(string(data)), filepath.Join(runtimeRoot, "example-plugin"); got != want {
		t.Fatalf("runtime dir = %q, want %q", got, want)
	}
	info, err := os.Stat(filepath.Join(runtimeRoot, "example-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Fatalf("runtime dir mode = %o, want 700", mode)
	}
}
