package config

import (
	"os"
	"path/filepath"
)

// Device defaults; overridable via env so dev hosts (no writable /opt) work.
const (
	defaultStateDir = "/opt/var/lib/mndw/ping-widget"
)

// StateDir is where hosts/stats JSON persist.
func StateDir() string {
	if dir := os.Getenv("MNDW_PLUGIN_DATA_DIR"); dir != "" {
		return dir
	}

	if dir := os.Getenv("MNDW_PING_STATE_DIR"); dir != "" {
		return dir
	}

	return defaultStateDir
}

func BackendSocketPath() string { return os.Getenv("MNDW_BACKEND_SOCKET") }

func HostsFile() string { return filepath.Join(StateDir(), "hosts.json") }
func StatsFile() string { return filepath.Join(StateDir(), "stats.json") }
