// Package pluginruntime resolves and prepares private runtime directories for
// plugin backend processes.
package pluginruntime

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RuntimeRootEnv names the daemon configuration environment variable used by
// development launchers and device init scripts.
const RuntimeRootEnv = "MNDW_PLUGIN_RUNTIME_ROOT"

// RuntimeDirEnv names the per-plugin runtime directory environment variable.
const RuntimeDirEnv = "MNDW_PLUGIN_RUNTIME_DIR"

// Ensure creates root/name and restricts both directories to the owner. Plugin
// names are validated here as defense in depth before becoming path components.
func Ensure(root, name string) (string, error) {
	dir, err := ForPlugin(root, name)
	if err != nil {
		return "", err
	}

	if dir == "" {
		return "", nil
	}

	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fmt.Errorf("create plugin runtime root: %w", err)
	}

	if err := os.Chmod(root, 0o700); err != nil {
		return "", fmt.Errorf("restrict plugin runtime root: %w", err)
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create plugin runtime directory: %w", err)
	}

	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("restrict plugin runtime directory: %w", err)
	}

	return dir, nil
}

// ForPlugin resolves one plugin's directory below root. Empty root disables
// runtime-directory injection for embedders that do not configure a root.
func ForPlugin(root, name string) (string, error) {
	if root == "" {
		return "", nil
	}

	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return "", fmt.Errorf("invalid plugin name for runtime directory: %q", name)
	}

	return filepath.Join(root, name), nil
}

// SetPluginEnv replaces inherited plugin identity/runtime values so a child
// process cannot accidentally use another plugin's directory.
func SetPluginEnv(env []string, name, dir string) []string {
	env = setEnv(env, "MNDW_PLUGIN_ID", name)

	return setEnv(env, RuntimeDirEnv, dir)
}

func setEnv(env []string, name, value string) []string {
	prefix := name + "="
	filtered := make([]string, 0, len(env)+1)

	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			filtered = append(filtered, entry)
		}
	}

	if value != "" {
		filtered = append(filtered, prefix+value)
	}

	return filtered
}
