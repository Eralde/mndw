package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mndwd/internal/pluginruntime"
	"mndwd/internal/rcisession"
)

// maxUploadBytes caps an upload request body at 10 MB.
const maxUploadBytes = 10 << 20

// Config is the daemon's fully-resolved runtime configuration, including package
// manager, authentication, backend execution, and storage settings.
type Config struct {
	Listen             string
	DataDir            string
	RCISessionStateDir string
	RCISessionKeyDir   string
	PluginRuntimeRoot  string
	BuiltinPluginsDir  string
	UserPluginsDir     string
	RouterURL          string
	ControllerURL      string
	Dev                bool
	Opkg               string
	LogLevel           string

	// Backend script dispatch limits.
	ExecTimeout       time.Duration
	MaxRequestBytes   int64
	MaxConcurrentExec int

	// Persistent RCI session limits.
	RCIEnumerationTTL        time.Duration
	RCIProxyIdleTimeout      time.Duration
	RCIProxyOperationTimeout time.Duration
	RCIProxyMaxInflight      int
	RCIProxyMaxResponseBytes int64
}

// StateFile is the path to the durable state document.
func (c Config) StateFile() string { return filepath.Join(c.DataDir, "state.json") }

// PaletteFile is the path to the device's optional colour-palette override.
func (c Config) PaletteFile() string { return filepath.Join(c.DataDir, "palette.json") }

// StagingDir holds uploaded-but-unapproved plugins.
func (c Config) StagingDir() string { return filepath.Join(c.DataDir, "staging") }

// RCISessionCiphertextFile returns the encrypted persistent-session record path.
func (c Config) RCISessionCiphertextFile() string {
	return filepath.Join(c.RCISessionStateDir, "rci-session.enc")
}

// RCISessionKeyFile returns the protected AES-GCM key path.
func (c Config) RCISessionKeyFile() string {
	return filepath.Join(c.RCISessionKeyDir, "rci-session.key")
}

// parseFlags parses argv into a Config. It returns showVersion=true when --version
// was passed so main can print and exit before doing any work.
func parseFlags(args []string) (cfg Config, showVersion bool, err error) {
	fs := flag.NewFlagSet("mndwd", flag.ContinueOnError)
	fs.StringVar(&cfg.Listen, "listen", "127.0.0.1:9090", "address to listen on")
	fs.StringVar(&cfg.DataDir, "data-dir", "/opt/var/lib/mndw", "directory for state.json and staging")
	fs.StringVar(&cfg.RCISessionStateDir, "rci-session-state-dir", "", "directory for encrypted persistent RCI session ciphertext")
	fs.StringVar(&cfg.RCISessionKeyDir, "rci-session-key-dir", "", "secure directory for the persistent RCI session key")
	fs.StringVar(&cfg.PluginRuntimeRoot, "plugin-runtime-root", "", "root directory for per-plugin runtime state")
	fs.StringVar(&cfg.BuiltinPluginsDir, "builtin-plugins-dir", "/opt/share/www/mndw/plugins", "directory of builtin plugins")
	fs.StringVar(&cfg.UserPluginsDir, "user-plugins-dir", "/opt/share/www/mndw/user-plugins", "directory of approved user plugins")
	fs.StringVar(&cfg.RouterURL, "router-url", "http://127.0.0.1:80", "router base URL for session auth")
	fs.StringVar(&cfg.ControllerURL, "controller-url", "", "controller base URL for persistent RCI requests")
	fs.BoolVar(&cfg.Dev, "dev", false, "dev mode: bypass session auth; logged loudly")
	fs.StringVar(&cfg.Opkg, "opkg", "exec", "opkg mode: exec|stub")
	fs.StringVar(&cfg.LogLevel, "log-level", "info", "log level: debug|info|warn|error")
	fs.DurationVar(&cfg.ExecTimeout, "exec-timeout", 30*time.Second, "per-request backend script timeout")
	fs.Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", 1<<20, "max backend request body size in bytes")
	fs.IntVar(&cfg.MaxConcurrentExec, "max-concurrent-exec", 8, "max concurrent script executions per plugin")
	fs.DurationVar(&cfg.RCIEnumerationTTL, "rci-enumeration-ttl", 30*time.Second, "persistent RCI member enumeration cache TTL")
	fs.DurationVar(&cfg.RCIProxyIdleTimeout, "rci-proxy-idle-timeout", 2*time.Minute, "persistent RCI socket idle timeout")
	fs.DurationVar(&cfg.RCIProxyOperationTimeout, "rci-proxy-operation-timeout", 0, "persistent RCI outbound operation timeout; defaults to exec-timeout")
	fs.IntVar(&cfg.RCIProxyMaxInflight, "rci-proxy-max-inflight", 8, "max persistent RCI requests in flight per socket")
	fs.Int64Var(&cfg.RCIProxyMaxResponseBytes, "rci-proxy-max-response-bytes", 1<<20, "max persistent RCI response body size in bytes")
	fs.BoolVar(&showVersion, "version", false, "print version and exit")

	if err = fs.Parse(args); err != nil {
		return cfg, false, err
	}
	if showVersion {
		return cfg, true, nil
	}
	controllerURLOverride := false
	fs.Visit(func(flag *flag.Flag) {
		if flag.Name == "controller-url" {
			controllerURLOverride = true
		}
	})
	if cfg.PluginRuntimeRoot == "" {
		cfg.PluginRuntimeRoot = os.Getenv(pluginruntime.RuntimeRootEnv)
	}
	if cfg.PluginRuntimeRoot == "" {
		cfg.PluginRuntimeRoot = filepath.Join(cfg.DataDir, "plugin-runtime")
	}
	if cfg.RCISessionStateDir == "" {
		cfg.RCISessionStateDir = cfg.DataDir
	}
	if !cfg.Dev && controllerURLOverride {
		return cfg, false, fmt.Errorf("--controller-url is available only in --dev mode")
	}
	if !cfg.Dev {
		cfg.ControllerURL = rcisession.DefaultControllerURL
	} else if !controllerURLOverride && strings.TrimSpace(os.Getenv("MNDW_HOST_DEVICE")) != "" {
		cfg.ControllerURL = strings.TrimSpace(os.Getenv("MNDW_HOST_DEVICE"))
	} else if cfg.ControllerURL == "" {
		cfg.ControllerURL = rcisession.DefaultControllerURL
	}
	if cfg.RCISessionKeyDir == "" {
		if cfg.Dev {
			cfg.RCISessionKeyDir = filepath.Join(filepath.Dir(cfg.DataDir), "rci-session-secrets")
		} else {
			cfg.RCISessionKeyDir = "/opt/var/lib/mndw-secrets"
		}
	}
	if cfg.RCIProxyOperationTimeout == 0 {
		cfg.RCIProxyOperationTimeout = cfg.ExecTimeout
	}
	if err := validatePersistentSessionConfig(cfg); err != nil {
		return cfg, false, err
	}
	if err := validateControllerURL(cfg.ControllerURL); err != nil {
		return cfg, false, err
	}
	if !cfg.Dev && !isLoopbackControllerURL(cfg.ControllerURL) {
		return cfg, false, fmt.Errorf("remote HTTP controller URL is not permitted outside --dev mode")
	}

	if cfg.Opkg != "exec" && cfg.Opkg != "stub" {
		return cfg, false, fmt.Errorf("--opkg must be exec or stub, got %q", cfg.Opkg)
	}
	if _, ok := parseLevel(cfg.LogLevel); !ok {
		return cfg, false, fmt.Errorf("--log-level must be debug|info|warn|error, got %q", cfg.LogLevel)
	}

	return cfg, false, nil
}

func validateControllerURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" {
		return fmt.Errorf("--controller-url must be an absolute HTTP(S) URL, got %q", raw)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return fmt.Errorf("--controller-url must contain only scheme and host, got %q", raw)
	}

	return nil
}

func isLoopbackControllerURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}

func validatePersistentSessionConfig(cfg Config) error {
	if !filepath.IsAbs(cfg.RCISessionStateDir) {
		return fmt.Errorf("--rci-session-state-dir must be absolute, got %q", cfg.RCISessionStateDir)
	}
	if !filepath.IsAbs(cfg.RCISessionKeyDir) {
		return fmt.Errorf("--rci-session-key-dir must be absolute, got %q", cfg.RCISessionKeyDir)
	}
	stateDir := filepath.Clean(cfg.RCISessionStateDir)
	keyDir := filepath.Clean(cfg.RCISessionKeyDir)
	rel, err := filepath.Rel(stateDir, keyDir)
	if err != nil {
		return fmt.Errorf("compare persistent RCI directories: %w", err)
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
		return fmt.Errorf("--rci-session-key-dir must be outside --rci-session-state-dir")
	}
	if cfg.RCIEnumerationTTL <= 0 {
		return fmt.Errorf("--rci-enumeration-ttl must be positive")
	}
	if cfg.RCIProxyIdleTimeout <= 0 {
		return fmt.Errorf("--rci-proxy-idle-timeout must be positive")
	}
	if cfg.RCIProxyOperationTimeout <= 0 {
		return fmt.Errorf("--rci-proxy-operation-timeout must be positive")
	}
	if cfg.RCIProxyMaxInflight <= 0 {
		return fmt.Errorf("--rci-proxy-max-inflight must be positive")
	}
	if cfg.RCIProxyMaxResponseBytes <= 0 {
		return fmt.Errorf("--rci-proxy-max-response-bytes must be positive")
	}
	return nil
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
