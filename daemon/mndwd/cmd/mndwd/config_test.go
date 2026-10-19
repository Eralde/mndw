package main

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"mndwd/internal/rcisession"
)

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

func TestParseDefaultsBackendLimitsAndTimeouts(t *testing.T) {
	cfg, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw"})
	if err != nil {
		t.Fatal(err)
	}

	if cfg.MaxConcurrentExecTotal != 8 || cfg.MaxConcurrentExecPerPlugin != 4 || cfg.MaxSupervisedServices != 8 {
		t.Fatalf("backend limits = total:%d plugin:%d services:%d", cfg.MaxConcurrentExecTotal, cfg.MaxConcurrentExecPerPlugin, cfg.MaxSupervisedServices)
	}

	if cfg.ExecKillGrace != 2*time.Second || cfg.ServiceHTTPTimeout != 30*time.Second || cfg.HTTPDrainTimeout != 35*time.Second {
		t.Fatalf("backend timeouts = grace:%s service:%s drain:%s", cfg.ExecKillGrace, cfg.ServiceHTTPTimeout, cfg.HTTPDrainTimeout)
	}

	if cfg.WebSocketCloseTimeout != 2*time.Second || cfg.ServiceStopTimeout != 15*time.Second || cfg.FinalReapTimeout != 2*time.Second || cfg.InitWaitTimeout != 60*time.Second {
		t.Fatalf("backend lifecycle timeouts = ws:%s stop:%s reap:%s init:%s", cfg.WebSocketCloseTimeout, cfg.ServiceStopTimeout, cfg.FinalReapTimeout, cfg.InitWaitTimeout)
	}

	if len(cfg.SupportedServiceProtocols) != 1 || cfg.SupportedServiceProtocols[0] != 1 {
		t.Fatalf("supported protocols = %#v, want [1]", cfg.SupportedServiceProtocols)
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
		{"--exec-kill-grace", "0s"},
		{"--service-http-timeout", "0s"},
		{"--http-drain-timeout", "1s"},
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

	if cfg.DiagnosticsLogFile != "/opt/var/log/mndwd.log" {
		t.Fatalf("diagnostics log file = %q, want production default", cfg.DiagnosticsLogFile)
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

	if cfg.RCIEnumerationTTL != 30*time.Second {
		t.Fatalf("RCI enumeration TTL = %s, want 30s", cfg.RCIEnumerationTTL)
	}

	if cfg.RCIHeartbeatInterval != 60*time.Second {
		t.Fatalf("RCI heartbeat interval = %s, want 60s", cfg.RCIHeartbeatInterval)
	}

	if cfg.RCIProxyIdleTimeout != 2*time.Minute {
		t.Fatalf("RCI proxy idle timeout = %s, want 2m", cfg.RCIProxyIdleTimeout)
	}

	if cfg.RCIProxyOperationTimeout != cfg.ExecTimeout {
		t.Fatalf("RCI proxy operation timeout = %s, want exec timeout %s", cfg.RCIProxyOperationTimeout, cfg.ExecTimeout)
	}

	if cfg.RCIProxyMaxInflight != 8 {
		t.Fatalf("RCI proxy max inflight = %d, want 8", cfg.RCIProxyMaxInflight)
	}

	if cfg.RCIProxyMaxResponseBytes != 1<<20 {
		t.Fatalf("RCI proxy max response bytes = %d, want 1 MiB", cfg.RCIProxyMaxResponseBytes)
	}
}

func TestParseRejectsHeartbeatIntervalOutsideBounds(t *testing.T) {
	for _, value := range []string{"44s", "148s"} {
		if _, _, err := parseFlags([]string{"--data-dir", "/var/lib/mndw", "--rci-heartbeat-interval", value}); err == nil {
			t.Fatalf("heartbeat interval %s accepted", value)
		}
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
		"--rci-enumeration-ttl", "45s",
		"--rci-proxy-idle-timeout", "3m",
		"--rci-proxy-operation-timeout", "17s",
		"--rci-proxy-max-inflight", "4",
		"--rci-proxy-max-response-bytes", "2048",
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
		{name: "zero enumeration ttl", args: []string{"--rci-enumeration-ttl", "0s"}},
		{name: "negative idle timeout", args: []string{"--rci-proxy-idle-timeout", "-1s"}},
		{name: "zero inflight", args: []string{"--rci-proxy-max-inflight", "0"}},
		{name: "zero response limit", args: []string{"--rci-proxy-max-response-bytes", "0"}},
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
	cfg := Config{DataDir: "/data/mndw", Opkg: "stub", ExecTimeout: 7 * time.Second}.withDefaults()

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

	if cfg.RCIProxyOperationTimeout != 7*time.Second {
		t.Errorf("RCIProxyOperationTimeout = %s, want exec timeout 7s", cfg.RCIProxyOperationTimeout)
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
		DataDir:                  "/d",
		UserPluginsDir:           "/u",
		PluginRuntimeRoot:        "/r",
		SelfUpdateStateDir:       "/s",
		SelfUpdateHelper:         "/h",
		DiagnosticsLogFile:       "/l",
		RRDDir:                   "/rrd",
		RCISessionStateDir:       "/state",
		RCISessionKeyDir:         "/keys",
		ControllerURL:            "http://192.0.2.1",
		RCIProxyOperationTimeout: 3 * time.Second,
		ExecTimeout:              9 * time.Second,
		Opkg:                     "exec",
		Service:                  "stub",
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

func TestParseStillRejectsExplicitZeroDurations(t *testing.T) {
	for _, args := range [][]string{
		{"--rci-heartbeat-interval", "0"},
		{"--http-drain-timeout", "0"},
		{"--rci-proxy-operation-timeout", "-1s"},
	} {
		if _, _, err := parseFlags(append([]string{"--data-dir", "/var/lib/mndw"}, args...)); err == nil {
			t.Errorf("parseFlags accepted %v", args)
		}
	}
}
