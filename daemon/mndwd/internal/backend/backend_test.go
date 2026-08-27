package backend

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/manifest"
	"mndwd/internal/registry"
)

func TestRuntimePathsAreDeterministicAndPrivate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "plugin-runtime")
	paths, err := NewRuntimePaths(root, "demo-plugin")
	if err != nil {
		t.Fatal(err)
	}

	if paths.PluginDir != filepath.Join(root, "demo-plugin") {
		t.Fatalf("PluginDir = %q", paths.PluginDir)
	}

	if paths.BackendSocket != filepath.Join(paths.PluginDir, "backend.sock") {
		t.Fatalf("BackendSocket = %q", paths.BackendSocket)
	}

	if paths.RCISessionSocket != filepath.Join(paths.PluginDir, "rci-session.sock") {
		t.Fatalf("RCISessionSocket = %q", paths.RCISessionSocket)
	}

	if paths.ServiceLease != filepath.Join(paths.PluginDir, "service.lease") {
		t.Fatalf("ServiceLease = %q", paths.ServiceLease)
	}

	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(paths.PluginDir)
	if err != nil {
		t.Fatal(err)
	}

	if info.Mode().Perm() != 0o700 {
		t.Fatalf("runtime directory mode = %o, want 700", info.Mode().Perm())
	}
}

func TestRuntimePathsRejectInvalidPluginIDs(t *testing.T) {
	for _, pluginID := range []string{"", ".", "..", "../escape", "nested/plugin", "bad\\id"} {
		if _, err := NewRuntimePaths(t.TempDir(), pluginID); err == nil {
			t.Errorf("NewRuntimePaths(%q) succeeded", pluginID)
		}
	}
}

func TestAdmissionChecksGlobalBeforePluginAndReleasesImmediately(t *testing.T) {
	admission := NewAdmission(Limits{MaxConcurrentExecTotal: 1, MaxConcurrentExecPerPlugin: 1, MaxSupervisedServices: 1})

	first, ok := admission.TryAcquireExec("one")

	if !ok {
		t.Fatal("first exec reservation rejected")
	}

	if _, ok := admission.TryAcquireExec("two"); ok {
		t.Fatal("global exec ceiling did not reject second plugin")
	}

	first.Release()

	second, ok := admission.TryAcquireExec("two")

	if !ok {
		t.Fatal("global reservation was not released")
	}

	second.Release()

	service, ok := admission.TryReserveService("svc")

	if !ok {
		t.Fatal("service reservation rejected")
	}

	duplicate, ok := admission.TryReserveService("svc")

	if !ok {
		t.Fatal("duplicate service reservation was not idempotent")
	}

	duplicate.Release()

	if _, services, _ := admission.Snapshot(); services != 1 {
		t.Fatalf("duplicate service release changed service count to %d", services)
	}

	if _, ok := admission.TryReserveService("other"); ok {
		t.Fatal("service ceiling did not reject second service")
	}

	service.Release()
}

func TestChildEnvironmentIsFreshAndAllowlisted(t *testing.T) {
	env := BuildChildEnvironment(EnvironmentSpec{
		Path:             "/opt/bin",
		PluginID:         "demo",
		PluginDir:        "/plugins/demo",
		PluginDataDir:    "/data/demo",
		PluginRuntimeDir: "/runtime/demo",
		BackendSocket:    "/runtime/demo/backend.sock",
		ProtocolVersion:  1,
		RCISessionSocket: "/runtime/demo/rci-session.sock",
		Service:          true,
	})
	joined := strings.Join(env, "\n")

	for _, expected := range []string{
		"PATH=/opt/bin",
		"MNDW_PLUGIN_ID=demo",
		"MNDW_PLUGIN_DIR=/plugins/demo",
		"MNDW_PLUGIN_DATA_DIR=/data/demo",
		"MNDW_PLUGIN_RUNTIME_DIR=/runtime/demo",
		"MNDW_BACKEND_SOCKET=/runtime/demo/backend.sock",
		"MNDW_BACKEND_PROTOCOL=1",
		"MNDW_RCI_SESSION_SOCKET=/runtime/demo/rci-session.sock",
	} {
		if !strings.Contains(joined, expected) {
			t.Errorf("environment missing %q: %s", expected, joined)
		}
	}

	if strings.Contains(joined, "HOME=") || strings.Contains(joined, "SECRET=") {
		t.Fatalf("environment inherited arbitrary values: %s", joined)
	}
}

func TestPersistentRCISocketPathIsDeclarationGated(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	declared, err := manifest.ValidateV3([]byte(`{"manifestVersion":3,"name":"declared","version":"1.0.0","type":"widget","label":"Declared","entry":"index.js","size":{"w":2,"h":2},"permissions":["persistent-rci-session:read"],"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`))
	if err != nil {
		t.Fatalf("validate declared manifest: %v", err)
	}

	undeclared, err := manifest.ValidateV3([]byte(`{"manifestVersion":3,"name":"undeclared","version":"1.0.0","type":"widget","label":"Undeclared","entry":"index.js","size":{"w":2,"h":2},"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`))
	if err != nil {
		t.Fatalf("validate undeclared manifest: %v", err)
	}

	if got := persistentRCISocket(root, &registry.Plugin{Name: "declared", Manifest: declared}); got == "" {
		t.Fatal("declared permission did not produce a deterministic socket path")
	}

	if got := persistentRCISocket(root, &registry.Plugin{Name: "undeclared", Manifest: undeclared}); got != "" {
		t.Fatalf("undeclared permission produced socket path %q", got)
	}
}

func TestValidateCommandRejectsSymlinkAndMalformedShebangWithoutSpawning(t *testing.T) {
	pluginDir := t.TempDir()

	if err := os.Mkdir(filepath.Join(pluginDir, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}

	command := filepath.Join(pluginDir, "backend", "command.sh")

	if err := os.WriteFile(command, []byte("#!/definitely/missing\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateCommand(pluginDir, "backend/command.sh"); err == nil {
		t.Fatal("missing interpreter accepted")
	}

	if err := os.Symlink(command, filepath.Join(pluginDir, "backend", "link.sh")); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateCommand(pluginDir, "backend/link.sh"); err == nil {
		t.Fatal("symlink command accepted")
	}
}

func TestValidateCommandAcceptsExecutableWithoutEarlyNewline(t *testing.T) {
	pluginDir := t.TempDir()

	if err := os.Mkdir(filepath.Join(pluginDir, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}

	command := filepath.Join(pluginDir, "backend", "binary")

	if err := os.WriteFile(command, bytes.Repeat([]byte{0x7f}, 4096), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateCommand(pluginDir, "backend/binary"); err != nil {
		t.Fatalf("newline-free executable rejected: %v", err)
	}
}
