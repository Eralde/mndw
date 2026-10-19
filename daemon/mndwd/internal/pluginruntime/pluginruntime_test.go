package pluginruntime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureCreatesPrivatePerPluginDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "plugin-runtime")

	dir, err := Ensure(root, "example-plugin")
	if err != nil {
		t.Fatal(err)
	}

	if want := filepath.Join(root, "example-plugin"); dir != want {
		t.Fatalf("dir = %q, want %q", dir, want)
	}

	for _, path := range []string{root, dir} {
		info, statErr := os.Stat(path)

		if statErr != nil {
			t.Fatal(statErr)
		}

		if mode := info.Mode().Perm(); mode != 0o700 {
			t.Errorf("%s mode = %o, want 700", path, mode)
		}
	}
}

func TestEnsureRejectsPathLikePluginID(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../other", "nested/plugin"} {
		if _, err := Ensure(t.TempDir(), name); err == nil {
			t.Errorf("Ensure(%q) error = nil", name)
		}
	}
}

func TestSetPluginEnvReplacesInheritedValues(t *testing.T) {
	env := SetPluginEnv([]string{
		"MNDW_PLUGIN_ID=wrong",
		"MNDW_PLUGIN_RUNTIME_DIR=/wrong",
		"PATH=/bin",
	}, "actual-plugin", "/runtime/actual-plugin")

	joined := strings.Join(env, "\n")

	if !strings.Contains(joined, "MNDW_PLUGIN_ID=actual-plugin") {
		t.Fatal("plugin ID was not set")
	}

	if !strings.Contains(joined, "MNDW_PLUGIN_RUNTIME_DIR=/runtime/actual-plugin") {
		t.Fatal("plugin runtime directory was not set")
	}

	if strings.Contains(joined, "MNDW_PLUGIN_ID=wrong") || strings.Contains(joined, "MNDW_PLUGIN_RUNTIME_DIR=/wrong") {
		t.Fatal("inherited plugin environment was not replaced")
	}
}
