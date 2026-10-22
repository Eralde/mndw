package mgmt

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type failingManagementEventPublisher struct {
	calls []string
	err   error
}

func (p *failingManagementEventPublisher) PublishPluginInstalled(contractEvents.PluginInstalledPayload) error {
	p.calls = append(p.calls, "plugin.installed")

	return p.err
}

func (p *failingManagementEventPublisher) PublishPluginApproved(contractEvents.PluginApprovedPayload) error {
	p.calls = append(p.calls, "plugin.approved")

	return p.err
}

func (p *failingManagementEventPublisher) PublishPluginRemoved(contractEvents.PluginRemovedPayload) error {
	p.calls = append(p.calls, "plugin.removed")

	return p.err
}

func TestManagementLogsAndIgnoresTypedPublishFailure(t *testing.T) {
	root := t.TempDir()
	cfg := Config{
		StagingDir:        filepath.Join(root, "staging"),
		UserPluginsDir:    filepath.Join(root, "plugins"),
		BuiltinPluginsDir: filepath.Join(root, "builtins"),
		Runtime:           passthroughRuntime{},
		EventPublisher:    &failingManagementEventPublisher{err: errors.New("bus unavailable")},
	}
	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	stagingPath := filepath.Join(cfg.StagingDir, "hello")

	if err := os.MkdirAll(stagingPath, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(stagingPath, "index.js"), []byte("export {}"), 0o600); err != nil {
		t.Fatal(err)
	}

	manifestValue, err := manifest.Validate([]byte(noBackendManifest))
	if err != nil {
		t.Fatal(err)
	}

	handler := New(cfg, store, nil, nil, registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir), discardLogger())
	response := httptest.NewRecorder()

	handler.installDirect(response, manifestValue, []byte(noBackendManifest), stagingPath)

	if response.Code != http.StatusCreated {
		t.Fatalf("install status = %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body.String())
	}

	if _, ok := store.Get("hello"); !ok {
		t.Fatal("plugin install was rolled back after event publish failure")
	}

	publisher := cfg.EventPublisher.(*failingManagementEventPublisher)

	if len(publisher.calls) != 1 || publisher.calls[0] != "plugin.installed" {
		t.Fatalf("published calls = %#v", publisher.calls)
	}
}
