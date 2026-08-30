package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mndwd/internal/pluginruntime"
	"mndwd/internal/rcisession"
)

// maxUploadBytes caps an upload request body at 10 MB.
const maxUploadBytes = 10 << 20

const defaultDiagnosticsLogFile = "/opt/var/log/mndwd.log"
const defaultPluginRuntimeRoot = "/opt/tmp/mndw/plugin-runtime"
const defaultSelfUpdateStateDir = "/opt/var/mndw"
const defaultSelfUpdateHelper = "/opt/share/www/mndw/bin/mndw-self-update.sh"

const (
	defaultRCIHeartbeatInterval = 60 * time.Second
	minRCIHeartbeatInterval     = 45 * time.Second
	maxRCIHeartbeatInterval     = 147 * time.Second
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
	// logger continues writing stdout; build/packaging/init/S70mndwd redirects it here.
	DiagnosticsLogFile string
	SelfUpdateStateDir string
	SelfUpdateHelper   string
	Dev                bool
	Opkg               string
	Service            string
	LogLevel           string

	// Exec/service runtime limits and timeouts.
	ExecTimeout                time.Duration
	ExecKillGrace              time.Duration
	ServiceHTTPTimeout         time.Duration
	HTTPDrainTimeout           time.Duration
	WebSocketCloseTimeout      time.Duration
	ServiceStopTimeout         time.Duration
	FinalReapTimeout           time.Duration
	InitWaitTimeout            time.Duration
	MaxRequestBytes            int64
	MaxConcurrentExecTotal     int
	MaxConcurrentExecPerPlugin int
	MaxSupervisedServices      int
	SupportedServiceProtocols  []int

	// Persistent RCI session limits.
	RCIEnumerationTTL        time.Duration
	RCIHeartbeatInterval     time.Duration
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
	fs.StringVar(&cfg.DiagnosticsLogFile, "diagnostics-log-file", defaultDiagnosticsLogFile, "read-only log path for diagnostics")
	fs.BoolVar(&cfg.Dev, "dev", false, "dev mode: bypass session auth; logged loudly")
	fs.StringVar(&cfg.Opkg, "opkg", "exec", "opkg mode: exec|stub")
	fs.StringVar(&cfg.Service, "service", "", "service mode: exec|stub; defaults to --opkg")
	fs.StringVar(&cfg.LogLevel, "log-level", "info", "log level: debug|info|warn|error")
	fs.DurationVar(&cfg.ExecTimeout, "exec-timeout", 30*time.Second, "per-request exec timeout")
	fs.DurationVar(&cfg.ExecKillGrace, "exec-kill-grace", 2*time.Second, "grace period after terminating an exec process group")
	fs.DurationVar(&cfg.ServiceHTTPTimeout, "service-http-timeout", 30*time.Second, "service backend HTTP timeout")
	fs.DurationVar(&cfg.HTTPDrainTimeout, "http-drain-timeout", 35*time.Second, "HTTP drain timeout during maintenance")
	fs.DurationVar(&cfg.WebSocketCloseTimeout, "websocket-close-timeout", 2*time.Second, "WebSocket maintenance close grace")
	fs.DurationVar(&cfg.ServiceStopTimeout, "service-stop-timeout", 15*time.Second, "service process group stop timeout")
	fs.DurationVar(&cfg.FinalReapTimeout, "final-reap-timeout", 2*time.Second, "final process group reap timeout")
	fs.DurationVar(&cfg.InitWaitTimeout, "init-wait-timeout", 60*time.Second, "init readiness wait timeout")
	fs.Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", 1<<20, "max backend request body size in bytes")
	fs.IntVar(&cfg.MaxConcurrentExecTotal, "max-concurrent-exec-total", 8, "global max concurrent exec requests")
	fs.IntVar(&cfg.MaxConcurrentExecPerPlugin, "max-concurrent-exec-per-plugin", 4, "per-plugin max concurrent exec requests")
	fs.IntVar(&cfg.MaxSupervisedServices, "max-supervised-services", 8, "global max supervised services")
	fs.DurationVar(&cfg.RCIEnumerationTTL, "rci-enumeration-ttl", 30*time.Second, "persistent RCI member enumeration cache TTL")
	fs.DurationVar(&cfg.RCIHeartbeatInterval, "rci-heartbeat-interval", defaultRCIHeartbeatInterval, "persistent RCI session heartbeat interval")
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

	if cfg.SelfUpdateStateDir == "" {
		cfg.SelfUpdateStateDir = defaultSelfUpdateStateDir
	}

	if cfg.SelfUpdateHelper == "" {
		cfg.SelfUpdateHelper = defaultSelfUpdateHelper
	}

	if cfg.UserPluginsDir == "" {
		cfg.UserPluginsDir = filepath.Join(cfg.DataDir, "user-plugins")
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
		cfg.PluginRuntimeRoot = defaultPluginRuntimeRoot
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

	if cfg.Service == "" {
		cfg.Service = cfg.Opkg
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

	if err := validateBackendConfig(cfg); err != nil {
		return cfg, false, err
	}

	cfg.SupportedServiceProtocols = []int{1}

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

	for _, item := range []struct {
		name  string
		value time.Duration
	}{
		{"exec-timeout", cfg.ExecTimeout},
		{"exec-kill-grace", cfg.ExecKillGrace},
		{"service-http-timeout", cfg.ServiceHTTPTimeout},
		{"http-drain-timeout", cfg.HTTPDrainTimeout},
		{"websocket-close-timeout", cfg.WebSocketCloseTimeout},
		{"service-stop-timeout", cfg.ServiceStopTimeout},
		{"final-reap-timeout", cfg.FinalReapTimeout},
		{"init-wait-timeout", cfg.InitWaitTimeout},
	} {
		if item.value <= 0 {
			return fmt.Errorf("--%s must be positive", item.name)
		}
	}

	minimumDrain := cfg.ExecTimeout + cfg.ExecKillGrace

	if cfg.ServiceHTTPTimeout > minimumDrain {
		minimumDrain = cfg.ServiceHTTPTimeout
	}

	if cfg.HTTPDrainTimeout < minimumDrain {
		return fmt.Errorf("--http-drain-timeout must be at least %s", minimumDrain)
	}

	return nil
}

func validateControllerURL(raw string) error {
	if _, err := rcisession.ValidateControllerURLShape(raw); err != nil {
		return fmt.Errorf("--controller-url must be an absolute HTTP(S) URL, got %q", raw)
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

	if cfg.RCIEnumerationTTL <= 0 {
		return fmt.Errorf("--rci-enumeration-ttl must be positive")
	}

	if cfg.RCIHeartbeatInterval < minRCIHeartbeatInterval || cfg.RCIHeartbeatInterval > maxRCIHeartbeatInterval {
		return fmt.Errorf("--rci-heartbeat-interval must be between %s and %s", minRCIHeartbeatInterval, maxRCIHeartbeatInterval)
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
