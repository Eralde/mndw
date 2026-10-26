package mgmt

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	contractEvents "mndw.local/contracts/events"
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
		MaxUploadBytes:    10 << 20,
		Runtime:           passthroughRuntime{},
		EventPublisher:    &failingManagementEventPublisher{err: errors.New("bus unavailable")},
	}
	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	New(cfg, store, nil, nil, registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir), discardLogger()).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	response := upload(t, srv, makeZip(t, map[string]string{
		"manifest.json": noBackendManifest,
		"index.js":      "export {}",
	}))
	defer response.Body.Close()

	if response.StatusCode != http.StatusCreated {
		t.Fatalf("install status = %d, want %d", response.StatusCode, http.StatusCreated)
	}

	if _, ok := store.Get("hello"); !ok {
		t.Fatal("plugin install was rolled back after event publish failure")
	}

	publisher := cfg.EventPublisher.(*failingManagementEventPublisher)

	if len(publisher.calls) != 1 || publisher.calls[0] != "plugin.installed" {
		t.Fatalf("published calls = %#v", publisher.calls)
	}
}
