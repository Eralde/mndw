package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/rcisession"
	"mndwd/internal/telemetry/system"
)

func TestRunKeepsCappedLogWhenLogFileCannotOpen(t *testing.T) {
	root := t.TempDir()
	blockingPath := filepath.Join(root, "not-a-directory")

	if err := os.WriteFile(blockingPath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}

	logPath := filepath.Join(root, "log-directory")

	if err := os.Mkdir(logPath, 0o700); err != nil {
		t.Fatal(err)
	}

	stdout, err := os.CreateTemp(root, "stdout-")
	if err != nil {
		t.Fatal(err)
	}

	stderr, err := os.CreateTemp(root, "stderr-")
	if err != nil {
		t.Fatal(err)
	}

	oldStdout, oldStderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = stdout, stderr

	defer func() {
		os.Stdout, os.Stderr = oldStdout, oldStderr
		_ = stdout.Close()
		_ = stderr.Close()
	}()

	cfg := Config{
		DataDir: filepath.Join(blockingPath, "state"),
		LogFile: logPath,
		Dev:     true,
	}

	if err := run(cfg); err == nil || !strings.Contains(err.Error(), "open state") {
		t.Fatalf("run error = %v, want startup to continue through log fallback", err)
	}

	stdoutBytes, err := os.ReadFile(stdout.Name())
	if err != nil {
		t.Fatal(err)
	}

	stderrBytes, err := os.ReadFile(stderr.Name())
	if err != nil {
		t.Fatal(err)
	}

	if got := string(stdoutBytes); got != "" {
		t.Fatalf("stdout grew after log open failure: %q", got)
	}

	if got := string(stderrBytes); strings.Count(got, "log file unavailable; writes will resume when it is writable") != 1 || strings.Count(got, "\n") != 1 {
		t.Fatalf("fallback diagnostic = %q, want one stderr line", got)
	}
}

func TestParseFlagsLimitDefaultsMatchBackend(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	defaults := backend.DefaultLimits()

	if cfg.MaxConcurrentExecTotal != defaults.MaxConcurrentExecTotal ||
		cfg.MaxConcurrentExecPerPlugin != defaults.MaxConcurrentExecPerPlugin ||
		cfg.MaxSupervisedServices != defaults.MaxSupervisedServices {
		t.Fatalf("config limits = total:%d plugin:%d services:%d, want %+v",
			cfg.MaxConcurrentExecTotal, cfg.MaxConcurrentExecPerPlugin, cfg.MaxSupervisedServices, defaults)
	}

}

func TestParseRejectsRemovedExecTimeoutFlag(t *testing.T) {
	if _, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--exec-timeout", "1s"}); err == nil {
		t.Fatal("removed exec timeout flag was accepted")
	}
}

func TestParseFlagsMaxOutputBytesDefault(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.MaxOutputBytes, backend.DefaultMaxOutputBytes; got != want {
		t.Fatalf("MaxOutputBytes = %d, want %d", got, want)
	}
}

func TestParseFlagsMaxOutputBytesOverride(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--max-output-bytes", "2048"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.MaxOutputBytes, int64(2048); got != want {
		t.Fatalf("MaxOutputBytes = %d, want %d", got, want)
	}
}

func TestParseFlagsRejectsNonPositiveMaxOutputBytes(t *testing.T) {
	_, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--max-output-bytes", "0"})
	if err == nil || !strings.Contains(err.Error(), "--max-output-bytes must be positive") {
		t.Fatalf("parseFlags error = %v, want --max-output-bytes must be positive", err)
	}
}

func TestBackendExecConfigCarriesLimits(t *testing.T) {
	cfg, _, err := parseFlags([]string{
		"--data-dir", "/var/lib/mndw",
		"--max-output-bytes", "4096",
		"--max-request-bytes", "512",
	})
	if err != nil {
		t.Fatal(err)
	}

	execCfg := backendExecConfig(cfg, slog.Default())

	if got, want := execCfg.MaxOutputBytes, int64(4096); got != want {
		t.Fatalf("MaxOutputBytes = %d, want %d", got, want)
	}

	if got, want := execCfg.MaxBodyBytes, int64(512); got != want {
		t.Fatalf("MaxBodyBytes = %d, want %d", got, want)
	}

	if got, want := execCfg.Timeout, cfg.ExecTimeout; got != want {
		t.Fatalf("Timeout = %s, want %s", got, want)
	}
}

func TestParseDefaultsUserPluginsDirUsesDurableDataRoot(t *testing.T) {
	t.Setenv("MNDW_USER_PLUGINS_DIR", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/opt/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.UserPluginsDir, "/opt/var/lib/mndw/user-plugins"; got != want {
		t.Fatalf("user plugins dir = %q, want %q", got, want)
	}

	if cfg.SelfUpdateStateDir != "/opt/var/mndw" || cfg.SelfUpdateHelper != "/opt/share/www/mndw/bin/mndw-self-update.sh" {
		t.Fatalf("self-update defaults = %q %q", cfg.SelfUpdateStateDir, cfg.SelfUpdateHelper)
	}
}

func TestParseAcceptsCanonicalDeviceURLFlag(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--device-url", "http://192.0.2.1:8081"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.DeviceURL != "http://192.0.2.1:8081" {
		t.Fatalf("device URL = %q, want canonical device URL", cfg.DeviceURL)
	}
}

func TestParseRejectsRouterURLFlag(t *testing.T) {
	if _, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--router-url", "http://192.0.2.1:8081"}); err == nil {
		t.Fatal("legacy router URL flag was accepted")
	}
}

func TestParseRejectsRemovedRRDToolFlag(t *testing.T) {
	if _, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--rrdtool-binary", "/opt/bin/rrdtool"}); err == nil {
		t.Fatal("removed RRDtool flag was accepted")
	}
}

func TestParseDefaultsUserPluginsDirUsesCustomDataRoot(t *testing.T) {
	t.Setenv("MNDW_USER_PLUGINS_DIR", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/mnt/usb/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.UserPluginsDir, "/mnt/usb/mndw/user-plugins"; got != want {
		t.Fatalf("user plugins dir = %q, want %q", got, want)
	}
}

func TestParseUserPluginsDirEnvironmentOverride(t *testing.T) {
	t.Setenv("MNDW_USER_PLUGINS_DIR", "/tmp/user-plugins")

	cfg, _, err := parseFlags([]string{"--data-dir", "/mnt/usb/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.UserPluginsDir, "/tmp/user-plugins"; got != want {
		t.Fatalf("user plugins dir = %q, want %q", got, want)
	}
}

func TestParseUserPluginsDirFlagOverridesEnvironment(t *testing.T) {
	t.Setenv("MNDW_USER_PLUGINS_DIR", "/tmp/env-user-plugins")

	cfg, _, err := parseFlags([]string{
		"--data-dir", "/mnt/usb/mndw",
		"--user-plugins-dir", "/tmp/flag-user-plugins",
	})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.UserPluginsDir, "/tmp/flag-user-plugins"; got != want {
		t.Fatalf("user plugins dir = %q, want %q", got, want)
	}
}

func TestParseDefaultsPluginRuntimeRootUsesDisposableRoot(t *testing.T) {
	t.Setenv("MNDW_PLUGIN_RUNTIME_ROOT", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.PluginRuntimeRoot, "/opt/tmp/mndw/plugin-runtime"; got != want {
		t.Fatalf("plugin runtime root = %q, want %q", got, want)
	}
}

func TestParseDefaultsBackendLimits(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	defaults := backend.DefaultLimits()

	if cfg.MaxConcurrentExecTotal != defaults.MaxConcurrentExecTotal || cfg.MaxConcurrentExecPerPlugin != defaults.MaxConcurrentExecPerPlugin || cfg.MaxSupervisedServices != defaults.MaxSupervisedServices {
		t.Fatalf("backend limits = total:%d plugin:%d services:%d, want %+v", cfg.MaxConcurrentExecTotal, cfg.MaxConcurrentExecPerPlugin, cfg.MaxSupervisedServices, defaults)
	}
}

func TestParseServiceDefaultsToOpkg(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--opkg", "stub"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Service != "stub" {
		t.Fatalf("service mode = %q, want stub", cfg.Service)
	}
}

func TestParseServiceOverrideAndValidation(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--opkg", "stub", "--service", "exec"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Service != "exec" {
		t.Fatalf("service mode = %q, want exec", cfg.Service)
	}

	if _, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--service", "invalid"}); err == nil {
		t.Fatal("invalid service mode succeeded")
	}
}

func TestParseRejectsInvalidBackendConfig(t *testing.T) {
	for _, args := range [][]string{
		{"--max-concurrent-exec-total", "0"},
		{"--max-concurrent-exec-per-plugin", "0"},
		{"--max-supervised-services", "0"},
	} {
		if _, _, err := parseFlags(args); err == nil {
			t.Errorf("parseFlags(%v) succeeded", args)
		}
	}
}

func TestParseDefaultsDiagnosticsLogFile(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.DiagnosticsLogFile != "/tmp/mndwd.log" {
		t.Fatalf("diagnostics log file = %q, want production default", cfg.DiagnosticsLogFile)
	}

	if cfg.DiagnosticsCrashLogFile != defaultDiagnosticsCrashLogFile {
		t.Fatalf("diagnostics crash log file = %q, want flag default %q", cfg.DiagnosticsCrashLogFile, defaultDiagnosticsCrashLogFile)
	}
}

func TestParseAcceptsLogFile(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--log-file", "/tmp/custom-mndwd.log"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.LogFile != "/tmp/custom-mndwd.log" {
		t.Fatalf("log file = %q, want override", cfg.LogFile)
	}
}

func TestParseAcceptsDiagnosticsLogFileOverride(t *testing.T) {
	cfg, _, err := parseFlags([]string{
		"--dev",
		"--diagnostics-log-file", "/tmp/mndwd-test.log",
		"--data-dir", "/tmp/mndw-dev-data",
	})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.DiagnosticsLogFile != "/tmp/mndwd-test.log" {
		t.Fatalf("diagnostics log file = %q, want override", cfg.DiagnosticsLogFile)
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

func TestParseDefaultsPersistentSessionConfig(t *testing.T) {
	t.Setenv("MNDW_HOST_DEVICE", "")

	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.RCISessionStateDir, "/var/lib/mndw"; got != want {
		t.Fatalf("RCI session state dir = %q, want %q", got, want)
	}

	if got, want := cfg.ControllerURL, "http://127.0.0.1:79"; got != want {
		t.Fatalf("controller URL = %q, want %q", got, want)
	}

	if got, want := cfg.RCISessionKeyDir, "/opt/var/lib/mndw-secrets"; got != want {
		t.Fatalf("RCI session key dir = %q, want %q", got, want)
	}

	if got, want := cfg.RCISessionCiphertextFile(), "/var/lib/mndw/rci-session.enc"; got != want {
		t.Fatalf("RCI ciphertext file = %q, want %q", got, want)
	}

	if got, want := cfg.RCISessionKeyFile(), "/opt/var/lib/mndw-secrets/rci-session.key"; got != want {
		t.Fatalf("RCI key file = %q, want %q", got, want)
	}

	if cfg.RCIProxyOperationTimeout != cfg.ExecTimeout {
		t.Fatalf("RCI proxy operation timeout = %s, want exec timeout %s", cfg.RCIProxyOperationTimeout, cfg.ExecTimeout)
	}

	if cfg.RCIProxyMaxResponseBytes != rcisession.DefaultMaxResponseBytes {
		t.Fatalf("RCI proxy max response bytes = %d, want 1 MiB", cfg.RCIProxyMaxResponseBytes)
	}
}

func TestParseDevUsesHostDeviceAsControllerURL(t *testing.T) {
	t.Setenv("MNDW_HOST_DEVICE", "http://192.168.1.1")

	cfg, _, err := parseFlags([]string{"--dev", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ControllerURL != "http://192.168.1.1" {
		t.Fatalf("controller URL = %q, want host device", cfg.ControllerURL)
	}
}

func TestParseDevAcceptsExplicitHTTPControllerURL(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--controller-url", "http://192.168.1.1:80", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ControllerURL != "http://192.168.1.1:80" {
		t.Fatalf("controller URL = %q", cfg.ControllerURL)
	}
}

func TestParseFlagsNormalizesControllerURL(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--controller-url", "http://192.0.2.1:79/", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.ControllerURL, "http://192.0.2.1:79"; got != want {
		t.Fatalf("ControllerURL = %q, want %q", got, want)
	}
}

func TestFrontDoorModeDetection(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--frontend-dir", "/opt/share/www/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if !cfg.FrontDoorMode() {
		t.Fatal("expected front-door mode on when --frontend-dir set")
	}

	if cfg.FrontendListen != "0.0.0.0" {
		t.Fatalf("default FrontendListen = %q, want 0.0.0.0", cfg.FrontendListen)
	}
}

func TestFrontDoorOffByDefault(t *testing.T) {
	cfg, _, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.FrontDoorMode() {
		t.Fatal("front-door mode must be off when --frontend-dir unset")
	}
}

func TestParseDevAcceptsHTTPSControllerURL(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--controller-url", "https://controller.example", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ControllerURL != "https://controller.example" {
		t.Fatalf("controller URL = %q", cfg.ControllerURL)
	}
}

func TestParseRejectsMalformedControllerURL(t *testing.T) {
	for _, value := range []string{
		"not-a-url",
		"http://user:password@192.168.1.1",
		"http://192.168.1.1/rci",
		"http://192.168.1.1?token=secret",
		" http://192.168.1.1",
		"http://192.168.1.1 ",
	} {
		if _, _, err := parseFlags([]string{"--dev", "--controller-url", value}); err == nil {
			t.Fatalf("controller URL %q accepted", value)
		}
	}
}

func TestParseDevDefaultsPersistentSessionKeyDirectoryOutsideDataDir(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--dev", "--data-dir", "/tmp/mndw-dev-data"})
	if err != nil {
		t.Fatal(err)
	}

	if got, want := cfg.RCISessionKeyDir, filepath.Join("/tmp", "rci-session-secrets"); got != want {
		t.Fatalf("dev RCI session key dir = %q, want %q", got, want)
	}
}

func TestParseRejectsProductionControllerURLOverride(t *testing.T) {
	_, _, err := parseFlags([]string{
		"--data-dir", "/var/lib/mndw",
		"--rci-session-state-dir", "/var/lib/mndw-rci",
		"--rci-session-key-dir", "/var/secure/mndw",
		"--controller-url", "http://192.168.1.1:80",
	})
	if err == nil {
		t.Fatal("production controller override accepted")
	}
}

func TestParseRejectsInvalidPersistentSessionConfig(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "key directory nested in state", args: []string{"--data-dir", "/var/lib/mndw", "--rci-session-key-dir", "/var/lib/mndw/secrets"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := parseFlags(test.args); err == nil {
				t.Fatal("parseFlags succeeded, want error")
			}
		})
	}
}

func TestWithDefaultsFillsUnsetFields(t *testing.T) {
	cfg := Config{DataDir: "/data/mndw", Opkg: "stub"}.withDefaults()

	for _, check := range []struct {
		name string
		got  string
		want string
	}{
		{"UserPluginsDir", cfg.UserPluginsDir, "/data/mndw/user-plugins"},
		{"PluginRuntimeRoot", cfg.PluginRuntimeRoot, defaultPluginRuntimeRoot},
		{"SelfUpdateStateDir", cfg.SelfUpdateStateDir, defaultSelfUpdateStateDir},
		{"SelfUpdateHelper", cfg.SelfUpdateHelper, defaultSelfUpdateHelper},
		{"DiagnosticsLogFile", cfg.DiagnosticsLogFile, defaultDiagnosticsLogFile},
		{"RRDDir", cfg.RRDDir, defaultRRDDir},
		{"RCISessionStateDir", cfg.RCISessionStateDir, "/data/mndw"},
		{"RCISessionKeyDir", cfg.RCISessionKeyDir, defaultRCISessionKeyDir},
		{"ControllerURL", cfg.ControllerURL, rcisession.DefaultControllerURL},
		{"Service", cfg.Service, "stub"},
	} {
		if check.got != check.want {
			t.Errorf("%s = %q, want %q", check.name, check.got, check.want)
		}
	}

	if cfg.RCIProxyOperationTimeout != cfg.ExecTimeout {
		t.Errorf("RCIProxyOperationTimeout = %s, want exec timeout %s", cfg.RCIProxyOperationTimeout, cfg.ExecTimeout)
	}

	if cfg.TelemetryMaxUnsynced != system.DefaultSyncEvery || cfg.ExecTimeout != backend.DefaultExecTimeout ||
		cfg.ServiceHTTPTimeout != backend.DefaultServiceHTTPTimeout || cfg.ServiceStopTimeout != backend.DefaultDaemonServiceStopTimeout ||
		cfg.FinalReapTimeout != backend.DefaultFinalReapTimeout || cfg.MaxRequestBytes != backend.DefaultMaxRequestBytes ||
		cfg.MaxOutputBytes != backend.DefaultMaxOutputBytes || cfg.RCIProxyMaxResponseBytes != rcisession.DefaultMaxResponseBytes {
		t.Errorf("withDefaults omitted E2 values: %+v", cfg)
	}

	limits := backend.DefaultLimits()

	if cfg.MaxConcurrentExecTotal != limits.MaxConcurrentExecTotal || cfg.MaxConcurrentExecPerPlugin != limits.MaxConcurrentExecPerPlugin ||
		cfg.MaxSupervisedServices != limits.MaxSupervisedServices {
		t.Errorf("withDefaults omitted backend capacity defaults: %+v", cfg)
	}
}

func TestDefaultHTTPDrainTimeoutCoversShutdownWindows(t *testing.T) {
	minimumDrain := backend.DefaultExecTimeout + backend.DefaultExecKillGrace

	if backend.DefaultServiceHTTPTimeout > minimumDrain {
		minimumDrain = backend.DefaultServiceHTTPTimeout
	}

	if defaultHTTPDrainTimeout < minimumDrain {
		t.Fatalf("HTTP drain timeout = %s, want at least %s", defaultHTTPDrainTimeout, minimumDrain)
	}
}

func TestWithDefaultsDevKeyDirSitsBesideDataDir(t *testing.T) {
	cfg := Config{DataDir: "/tmp/mndw-dev-data", Dev: true}.withDefaults()

	if got, want := cfg.RCISessionKeyDir, "/tmp/rci-session-secrets"; got != want {
		t.Fatalf("dev RCI session key dir = %q, want %q", got, want)
	}
}

func TestWithDefaultsKeepsExplicitValues(t *testing.T) {
	explicit := Config{
		DataDir:                    "/d",
		UserPluginsDir:             "/u",
		PluginRuntimeRoot:          "/r",
		SelfUpdateStateDir:         "/s",
		SelfUpdateHelper:           "/h",
		DiagnosticsLogFile:         "/l",
		RRDDir:                     "/rrd",
		RCISessionStateDir:         "/state",
		RCISessionKeyDir:           "/keys",
		ControllerURL:              "http://192.0.2.1",
		TelemetryMaxUnsynced:       4 * time.Minute,
		RCIProxyOperationTimeout:   3 * time.Second,
		ExecTimeout:                9 * time.Second,
		ServiceHTTPTimeout:         12 * time.Second,
		ServiceStopTimeout:         11 * time.Second,
		FinalReapTimeout:           time.Second,
		RCIProxyMaxResponseBytes:   2048,
		MaxRequestBytes:            4096,
		MaxOutputBytes:             8192,
		MaxConcurrentExecTotal:     1,
		MaxConcurrentExecPerPlugin: 1,
		MaxSupervisedServices:      1,
		Opkg:                       "exec",
		Service:                    "stub",
	}

	if got := explicit.withDefaults(); !reflect.DeepEqual(got, explicit) {
		t.Fatalf("withDefaults changed explicit values:\n got %#v\nwant %#v", got, explicit)
	}
}

func TestWithDefaultsIsIdempotent(t *testing.T) {
	once := Config{DataDir: "/data/mndw", Dev: true, Opkg: "exec", ExecTimeout: time.Second}.withDefaults()

	if twice := once.withDefaults(); !reflect.DeepEqual(twice, once) {
		t.Fatalf("second withDefaults changed config:\n got %#v\nwant %#v", twice, once)
	}
}
