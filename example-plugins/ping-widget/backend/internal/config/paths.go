package config

import (
	"os"
	"path/filepath"
)

// Device defaults; overridable via env so dev hosts (no writable /opt) work.
const (
	defaultRuntimeDir = "/tmp"
	defaultStateDir   = "/opt/var/lib/mndw/ping-widget"
)

func runtimeDir() string {
	if dir := os.Getenv("MNDW_PING_RUNTIME_DIR"); dir != "" {
		return dir
	}

	return defaultRuntimeDir
}

// StateDir is where hosts/stats JSON persist.
func StateDir() string {
	if dir := os.Getenv("MNDW_PING_STATE_DIR"); dir != "" {
		return dir
	}

	return defaultStateDir
}

func SocketPath() string  { return filepath.Join(runtimeDir(), "ping-widget.sock") }
func PidFilePath() string { return filepath.Join(runtimeDir(), "ping-widget.pid") }
func HostsFile() string   { return filepath.Join(StateDir(), "hosts.json") }
func StatsFile() string   { return filepath.Join(StateDir(), "stats.json") }
