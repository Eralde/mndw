package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/rcisession"
	"mndwd/internal/telemetry/system"
)

// maxUploadBytes caps an upload request body at 10 MB.
const maxUploadBytes = 10 << 20

const defaultDiagnosticsLogFile = "/tmp/mndwd.log"
const defaultDiagnosticsCrashLogFile = "/opt/var/log/mndwd.crash.log"
const defaultPluginRuntimeRoot = "/opt/tmp/mndw/plugin-runtime"
const pluginRuntimeRootEnv = "MNDW_PLUGIN_RUNTIME_ROOT"
const defaultSelfUpdateStateDir = "/opt/var/mndw"
const defaultSelfUpdateHelper = "/opt/share/www/mndw/bin/mndw-self-update.sh"
const defaultRRDDir = "/opt/var/lib/mndw/rrd"
const defaultRCISessionKeyDir = "/opt/var/lib/mndw-secrets"

const (
	defaultHTTPIdleTimeout  = 120 * time.Second
	defaultHTTPDrainTimeout = 35 * time.Second
)

// Config is the daemon's fully-resolved runtime configuration, including package
// manager, authentication, exec/service runtime, and storage settings.
type Config struct {
	Listen             string
	FrontendDir        string
	FrontendListen     string
	DataDir            string
	RCISessionStateDir string
	RCISessionKeyDir   string
	PluginRuntimeRoot  string
	BuiltinPluginsDir  string
	UserPluginsDir     string
	DeviceURL          string
	ControllerURL      string
	// DiagnosticsLogFile is a read-only path that diagnostics tails. mndwd's
	// logger continues writing the RAM log at LogFile unless overridden.
	LogFile                 string
	DiagnosticsLogFile      string
	DiagnosticsCrashLogFile string
	SelfUpdateStateDir      string
	SelfUpdateHelper        string
	Dev                     bool
	Opkg                    string
	Service                 string
	LogLevel                string
	RRDDir                  string
	TelemetryMaxUnsynced    time.Duration

	// Exec/service runtime limits and timeouts.
	ExecTimeout                time.Duration
	ServiceHTTPTimeout         time.Duration
	ServiceStopTimeout         time.Duration
	FinalReapTimeout           time.Duration
	MaxRequestBytes            int64
	MaxOutputBytes             int64
	MaxConcurrentExecTotal     int
	MaxConcurrentExecPerPlugin int
	MaxSupervisedServices      int

	// Persistent RCI session limits.
	RCIProxyOperationTimeout time.Duration
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

// withDefaults fills unset configuration fields without reading environment
// variables. Environment and --dev policy stay in parseFlags.
func (c Config) withDefaults() Config {
	if c.TelemetryMaxUnsynced <= 0 {
		c.TelemetryMaxUnsynced = system.DefaultSyncEvery
	}

	if c.ExecTimeout <= 0 {
		c.ExecTimeout = backend.DefaultExecTimeout
	}

	if c.ServiceHTTPTimeout <= 0 {
		c.ServiceHTTPTimeout = backend.DefaultServiceHTTPTimeout
	}

	if c.ServiceStopTimeout <= 0 {
		c.ServiceStopTimeout = backend.DefaultDaemonServiceStopTimeout
	}

	if c.FinalReapTimeout <= 0 {
		c.FinalReapTimeout = backend.DefaultFinalReapTimeout
	}

	if c.MaxRequestBytes <= 0 {
		c.MaxRequestBytes = backend.DefaultMaxRequestBytes
	}

	if c.MaxOutputBytes <= 0 {
		c.MaxOutputBytes = backend.DefaultMaxOutputBytes
	}

	limits := backend.DefaultLimits()

	if c.MaxConcurrentExecTotal <= 0 {
		c.MaxConcurrentExecTotal = limits.MaxConcurrentExecTotal
	}

	if c.MaxConcurrentExecPerPlugin <= 0 {
		c.MaxConcurrentExecPerPlugin = limits.MaxConcurrentExecPerPlugin
	}

	if c.MaxSupervisedServices <= 0 {
		c.MaxSupervisedServices = limits.MaxSupervisedServices
	}

	if c.RCIProxyMaxResponseBytes <= 0 {
		c.RCIProxyMaxResponseBytes = rcisession.DefaultMaxResponseBytes
	}

	if c.UserPluginsDir == "" {
		c.UserPluginsDir = filepath.Join(c.DataDir, "user-plugins")
	}

	if c.PluginRuntimeRoot == "" {
		c.PluginRuntimeRoot = defaultPluginRuntimeRoot
	}

	if c.SelfUpdateStateDir == "" {
		c.SelfUpdateStateDir = defaultSelfUpdateStateDir
	}

	if c.SelfUpdateHelper == "" {
		c.SelfUpdateHelper = defaultSelfUpdateHelper
	}

	if c.DiagnosticsLogFile == "" {
		c.DiagnosticsLogFile = c.LogFile

		if c.DiagnosticsLogFile == "" {
			c.DiagnosticsLogFile = defaultDiagnosticsLogFile
		}
	}

	if c.RRDDir == "" {
		c.RRDDir = defaultRRDDir
	}

	if c.RCISessionStateDir == "" {
		c.RCISessionStateDir = c.DataDir
	}

	if c.RCISessionKeyDir == "" {
		if c.Dev {
			c.RCISessionKeyDir = filepath.Join(filepath.Dir(c.DataDir), "rci-session-secrets")
		} else {
			c.RCISessionKeyDir = defaultRCISessionKeyDir
		}
	}

	if c.ControllerURL == "" {
		c.ControllerURL = rcisession.DefaultControllerURL
	}

	if c.RCIProxyOperationTimeout == 0 {
		c.RCIProxyOperationTimeout = c.ExecTimeout
	}

	if c.Service == "" {
		c.Service = c.Opkg
	}

	return c
}

// parseFlags parses argv into a Config. It returns showVersion=true when --version
// was passed so main can print and exit before doing any work.
func parseFlags(args []string) (cfg Config, showVersion bool, err error) {
	fs := flag.NewFlagSet("mndwd", flag.ContinueOnError)

	fs.StringVar(&cfg.Listen, "listen", "127.0.0.1:9090", "address to listen on")
	fs.StringVar(&cfg.FrontendDir, "frontend-dir", "", "SPA document root; when set, front-door mode is on")
	fs.StringVar(&cfg.FrontendListen, "frontend-listen", "0.0.0.0", "front-door bind address (all interfaces for LAN parity)")
	fs.StringVar(&cfg.DataDir, "data-dir", "/opt/var/lib/mndw", "directory for state.json and staging")
	fs.StringVar(&cfg.RCISessionStateDir, "rci-session-state-dir", "", "directory for encrypted persistent RCI session ciphertext")
	fs.StringVar(&cfg.RCISessionKeyDir, "rci-session-key-dir", "", "secure directory for the persistent RCI session key")
	fs.StringVar(&cfg.PluginRuntimeRoot, "plugin-runtime-root", "", "root directory for per-plugin runtime state")
	fs.StringVar(&cfg.BuiltinPluginsDir, "builtin-plugins-dir", "/opt/share/www/mndw/plugins", "directory of builtin plugins")

	userPluginsDirDefault := os.Getenv("MNDW_USER_PLUGINS_DIR")

	fs.StringVar(&cfg.UserPluginsDir, "user-plugins-dir", userPluginsDirDefault, "directory of approved user plugins")

	const defaultDeviceURL = "http://127.0.0.1:80"

	fs.StringVar(&cfg.DeviceURL, "device-url", defaultDeviceURL, "network device base URL for session auth and device proxying")
	fs.StringVar(&cfg.ControllerURL, "controller-url", "", "controller base URL for persistent RCI requests")
	fs.StringVar(&cfg.LogFile, "log-file", "", "write logs to a bounded rotating file instead of stdout")
	fs.StringVar(&cfg.DiagnosticsLogFile, "diagnostics-log-file", "", "read-only log path for diagnostics; defaults to --log-file or /tmp/mndwd.log")
	fs.StringVar(&cfg.DiagnosticsCrashLogFile, "diagnostics-crash-log-file", defaultDiagnosticsCrashLogFile, "read-only stdout/stderr crash log path for diagnostics")
	fs.BoolVar(&cfg.Dev, "dev", false, "dev mode: bypass session auth; logged loudly")
	fs.StringVar(&cfg.Opkg, "opkg", "exec", "opkg mode: exec|stub")
	fs.StringVar(&cfg.Service, "service", "", "service mode: exec|stub; defaults to --opkg")
	fs.StringVar(&cfg.LogLevel, "log-level", "info", "log level: debug|info|warn|error")
	fs.StringVar(&cfg.RRDDir, "rrd-dir", defaultRRDDir, "private durable telemetry directory")

	limits := backend.DefaultLimits()

	fs.Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", backend.DefaultMaxRequestBytes, "max backend request body size in bytes")
	fs.Int64Var(&cfg.MaxOutputBytes, "max-output-bytes", backend.DefaultMaxOutputBytes, "max backend exec response size in bytes")

	fs.IntVar(&cfg.MaxConcurrentExecTotal, "max-concurrent-exec-total", limits.MaxConcurrentExecTotal, "global max concurrent exec requests")
	fs.IntVar(&cfg.MaxConcurrentExecPerPlugin, "max-concurrent-exec-per-plugin", limits.MaxConcurrentExecPerPlugin, "per-plugin max concurrent exec requests")
	fs.IntVar(&cfg.MaxSupervisedServices, "max-supervised-services", limits.MaxSupervisedServices, "global max supervised services")
	fs.BoolVar(&showVersion, "version", false, "print version and exit")

	if err = fs.Parse(args); err != nil {
		return cfg, false, err
	}

	if err := validateBackendConfig(cfg); err != nil {
		return cfg, false, err
	}

	if showVersion {
		return cfg, true, nil
	}

	controllerURLOverride := flagWasSet(fs, "controller-url")

	if cfg.PluginRuntimeRoot == "" {
		cfg.PluginRuntimeRoot = os.Getenv(pluginRuntimeRootEnv)
	}

	if !cfg.Dev && controllerURLOverride {
		return cfg, false, fmt.Errorf("--controller-url is available only in --dev mode")
	}

	if !cfg.Dev {
		cfg.ControllerURL = rcisession.DefaultControllerURL
	} else if !controllerURLOverride && strings.TrimSpace(os.Getenv("MNDW_HOST_DEVICE")) != "" {
		cfg.ControllerURL = strings.TrimSpace(os.Getenv("MNDW_HOST_DEVICE"))
	}

	cfg = cfg.withDefaults()

	if cfg.TelemetryMaxUnsynced > 15*time.Minute {
		return cfg, false, errors.New("telemetry maximum unsynced duration must not exceed 15m")
	}

	if err := validatePersistentSessionConfig(cfg); err != nil {
		return cfg, false, err
	}

	controllerURL, err := rcisession.ValidateControllerURLShape(cfg.ControllerURL)
	if err != nil {
		return cfg, false, err
	}

	cfg.ControllerURL = strings.TrimRight(controllerURL.String(), "/")

	if !cfg.Dev && !isLoopbackControllerURL(cfg.ControllerURL) {
		return cfg, false, fmt.Errorf("remote HTTP controller URL is not permitted outside --dev mode")
	}

	if cfg.Opkg != "exec" && cfg.Opkg != "stub" {
		return cfg, false, fmt.Errorf("--opkg must be exec or stub, got %q", cfg.Opkg)
	}

	if cfg.Service != "exec" && cfg.Service != "stub" {
		return cfg, false, fmt.Errorf("--service must be exec or stub, got %q", cfg.Service)
	}

	if _, ok := parseLevel(cfg.LogLevel); !ok {
		return cfg, false, fmt.Errorf("--log-level must be debug|info|warn|error, got %q", cfg.LogLevel)
	}

	for _, item := range []struct {
		flagName string
		envName  string
		target   *int
	}{
		{flagName: "max-concurrent-exec-total", envName: "MNDWD_MAX_CONCURRENT_EXEC_TOTAL", target: &cfg.MaxConcurrentExecTotal},
		{flagName: "max-concurrent-exec-per-plugin", envName: "MNDWD_MAX_CONCURRENT_EXEC_PER_PLUGIN", target: &cfg.MaxConcurrentExecPerPlugin},
		{flagName: "max-supervised-services", envName: "MNDWD_MAX_SUPERVISED_SERVICES", target: &cfg.MaxSupervisedServices},
	} {
		if flagWasSet(fs, item.flagName) {
			continue
		}

		value, present := os.LookupEnv(item.envName)

		if !present || value == "" {
			continue
		}

		parsed, parseErr := strconv.Atoi(value)

		if parseErr != nil || parsed <= 0 {
			return cfg, false, fmt.Errorf("%s must be a positive integer", item.envName)
		}

		*item.target = parsed
	}

	return cfg, false, nil
}

// FrontDoorMode reports whether the daemon serves the browser-facing front door.
func (c Config) FrontDoorMode() bool { return strings.TrimSpace(c.FrontendDir) != "" }

func flagWasSet(flags *flag.FlagSet, name string) bool {
	set := false

	flags.Visit(func(item *flag.Flag) {
		if item.Name == name {
			set = true
		}
	})

	return set
}

func validateBackendConfig(cfg Config) error {
	if cfg.MaxRequestBytes <= 0 {
		return fmt.Errorf("--max-request-bytes must be positive")
	}

	if cfg.MaxOutputBytes <= 0 {
		return fmt.Errorf("--max-output-bytes must be positive")
	}

	positive := []struct {
		name  string
		value int
	}{
		{"max-concurrent-exec-total", cfg.MaxConcurrentExecTotal},
		{"max-concurrent-exec-per-plugin", cfg.MaxConcurrentExecPerPlugin},
		{"max-supervised-services", cfg.MaxSupervisedServices},
	}

	for _, item := range positive {
		if item.value <= 0 {
			return fmt.Errorf("--%s must be positive", item.name)
		}
	}

	return nil
}

func isLoopbackControllerURL(raw string) bool {
	parsed, err := rcisession.ValidateControllerURLShape(raw)
	if err != nil {
		return false
	}

	return parsed.Scheme == "http" && rcisession.IsLoopbackHost(parsed.Hostname())
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

	if cfg.RCIProxyOperationTimeout <= 0 {
		return fmt.Errorf("RCI proxy operation timeout must be positive")
	}

	if cfg.RCIProxyMaxResponseBytes <= 0 {
		return fmt.Errorf("RCI proxy max response bytes must be positive")
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
