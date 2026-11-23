package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

func TestPrintPluginPackagesReportsApprovedUserPackagesReadOnly(t *testing.T) {
	dataDir := t.TempDir()
	statePath := filepath.Join(dataDir, "state.json")
	stateBytes, err := json.Marshal(state.State{
		Version: 1,
		Plugins: map[string]*state.Plugin{
			"alpha": {
				Name: "alpha", Source: state.SourceUpload, Approval: state.ApprovalApproved, Enabled: false,
				Manifest: json.RawMessage(serviceManifest("alpha", "zlib", "ttyd")),
			},
			"beta": {
				Name: "beta", Source: state.SourceRegistry, Approval: state.ApprovalApproved, Enabled: true,
				Manifest: json.RawMessage(serviceManifest("beta", "ca-bundle", "zlib")),
			},
			"builtin": {
				Name: "builtin", Source: state.SourceBuiltin, Approval: state.ApprovalApproved, Enabled: true,
				Manifest: json.RawMessage(serviceManifest("builtin", "builtin-only")),
			},
			"pending": {
				Name: "pending", Source: state.SourceUpload, Approval: state.ApprovalPending, Enabled: false,
				Manifest: json.RawMessage(serviceManifest("pending", "pending-only")),
			},
			"invalid": {
				Name: "invalid", Source: state.SourceUpload, Approval: state.ApprovalApproved, Enabled: true,
				Manifest: json.RawMessage(`{"manifestVersion":999}`),
			},
		},
		Audit: []state.AuditEntry{},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	cfg, _, err := parseFlags([]string{"--data-dir", dataDir, "--user-plugins-dir", filepath.Join(dataDir, "user-plugins")})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}

	if err := printPluginPackages(cfg, &stdout, &stderr); err != nil {
		t.Fatalf("printPluginPackages: %v", err)
	}

	if got, want := stdout.String(), "ca-bundle beta\nttyd alpha\nzlib alpha,beta\n"; got != want {
		t.Fatalf("plugin package output = %q, want %q", got, want)
	}

	if !strings.Contains(stderr.String(), "invalid") {
		t.Fatalf("invalid manifest warning = %q, want plugin name", stderr.String())
	}

	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("read state after report: %v", err)
	}

	if !bytes.Equal(after, stateBytes) {
		t.Fatal("package report changed state.json")
	}

	if _, err := os.Stat(filepath.Join(dataDir, "palette.json")); !os.IsNotExist(err) {
		t.Fatalf("package report touched palette state: stat error = %v", err)
	}
}

func TestManifestPluginNamesCannotContainPackageOutputSeparators(t *testing.T) {
	for _, name := range []string{"alpha", "alpha-beta"} {
		validated, err := manifest.Validate([]byte(serviceManifest(name)))
		if err != nil {
			t.Fatalf("manifest.Validate(%q): %v", name, err)
		}

		if strings.ContainsAny(validated.Name, " ,") {
			t.Fatalf("validated plugin name %q contains an output separator", validated.Name)
		}
	}

	for _, name := range []string{"bad name", "bad,name"} {
		if _, err := manifest.Validate([]byte(serviceManifest(name))); err == nil {
			t.Fatalf("manifest.Validate(%q) succeeded; want invalid plugin name", name)
		}
	}
}

func TestParsePrintPluginPackagesRespectsUserPluginDirectoryEnvironment(t *testing.T) {
	userPluginsDir := filepath.Join(t.TempDir(), "user plugins")

	t.Setenv("MNDW_USER_PLUGINS_DIR", userPluginsDir)

	cfg, _, err := parseFlags([]string{"--data-dir", filepath.Join(t.TempDir(), "data"), "--print-plugin-packages"})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}

	if cfg.UserPluginsDir != userPluginsDir {
		t.Fatalf("user plugins dir = %q, want env value %q", cfg.UserPluginsDir, userPluginsDir)
	}

	if !cfg.PrintPluginPackages {
		t.Fatal("--print-plugin-packages did not set the report flag")
	}
}

func serviceManifest(name string, packages ...string) string {
	packageJSON, _ := json.Marshal(packages)

	return `{"manifestVersion":1,"name":"` + name + `","version":"1.0.0","type":"page","label":"` + name + `","entry":"index.js","route":"/` + name + `","backend":{"kind":"service","protocolVersion":1,"command":"backend/server","packages":` + string(packageJSON) + `,"routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`
}
