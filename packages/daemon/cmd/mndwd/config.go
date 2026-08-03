package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"mndwd/internal/pluginruntime"
)

// maxUploadBytes caps an upload request body at 10 MB.
const maxUploadBytes = 10 << 20

// Config is the daemon's fully-resolved runtime configuration, including package
// manager, authentication, backend execution, and storage settings.
type Config struct {
	Listen            string
	DataDir           string
	PluginRuntimeRoot string
	BuiltinPluginsDir string
	UserPluginsDir    string
	RouterURL         string
	Dev               bool
	Opkg              string
	LogLevel          string

	// Backend script dispatch limits.
	ExecTimeout       time.Duration
	MaxRequestBytes   int64
	MaxConcurrentExec int
}

// StateFile is the path to the durable state document.
func (c Config) StateFile() string { return filepath.Join(c.DataDir, "state.json") }

// PaletteFile is the path to the device's optional colour-palette override.
func (c Config) PaletteFile() string { return filepath.Join(c.DataDir, "palette.json") }

// StagingDir holds uploaded-but-unapproved plugins.
func (c Config) StagingDir() string { return filepath.Join(c.DataDir, "staging") }

// parseFlags parses argv into a Config. It returns showVersion=true when --version
// was passed so main can print and exit before doing any work.
func parseFlags(args []string) (cfg Config, showVersion bool, err error) {
	fs := flag.NewFlagSet("mndwd", flag.ContinueOnError)
	fs.StringVar(&cfg.Listen, "listen", "127.0.0.1:9090", "address to listen on")
	fs.StringVar(&cfg.DataDir, "data-dir", "/opt/var/lib/mndw", "directory for state.json and staging")
	fs.StringVar(&cfg.PluginRuntimeRoot, "plugin-runtime-root", "", "root directory for per-plugin runtime state")
	fs.StringVar(&cfg.BuiltinPluginsDir, "builtin-plugins-dir", "/opt/share/www/mndw/plugins", "directory of builtin plugins")
	fs.StringVar(&cfg.UserPluginsDir, "user-plugins-dir", "/opt/share/www/mndw/user-plugins", "directory of approved user plugins")
	fs.StringVar(&cfg.RouterURL, "router-url", "http://127.0.0.1:80", "router base URL for session auth")
	fs.BoolVar(&cfg.Dev, "dev", false, "dev mode: bypass session auth; logged loudly")
	fs.StringVar(&cfg.Opkg, "opkg", "exec", "opkg mode: exec|stub")
	fs.StringVar(&cfg.LogLevel, "log-level", "info", "log level: debug|info|warn|error")
	fs.DurationVar(&cfg.ExecTimeout, "exec-timeout", 30*time.Second, "per-request backend script timeout")
	fs.Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", 1<<20, "max backend request body size in bytes")
	fs.IntVar(&cfg.MaxConcurrentExec, "max-concurrent-exec", 8, "max concurrent script executions per plugin")
	fs.BoolVar(&showVersion, "version", false, "print version and exit")

	if err = fs.Parse(args); err != nil {
		return cfg, false, err
	}
	if showVersion {
		return cfg, true, nil
	}
	if cfg.PluginRuntimeRoot == "" {
		cfg.PluginRuntimeRoot = os.Getenv(pluginruntime.RuntimeRootEnv)
	}
	if cfg.PluginRuntimeRoot == "" {
		cfg.PluginRuntimeRoot = filepath.Join(cfg.DataDir, "plugin-runtime")
	}

	if cfg.Opkg != "exec" && cfg.Opkg != "stub" {
		return cfg, false, fmt.Errorf("--opkg must be exec or stub, got %q", cfg.Opkg)
	}
	if _, ok := parseLevel(cfg.LogLevel); !ok {
		return cfg, false, fmt.Errorf("--log-level must be debug|info|warn|error, got %q", cfg.LogLevel)
	}

	return cfg, false, nil
}

// parseLevel maps a level name to slog.Level.
func parseLevel(name string) (slog.Level, bool) {
	switch name {
	case "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}
