package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/socket"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestControllerPermissionAvailableUsesControllerSupport(t *testing.T) {
	tests := []struct {
		name       string
		controller *model.TokenRecord
		want       bool
	}{
		{name: "missing", want: false},
		{name: "supported without token", controller: &model.TokenRecord{Support: model.SupportSupported}, want: true},
		{name: "supported with token", controller: &model.TokenRecord{Token: "token", Support: model.SupportSupported}, want: true},
		{name: "unsupported", controller: &model.TokenRecord{Token: "token", Support: model.SupportUnsupported}, want: false},
		{name: "invalid", controller: &model.TokenRecord{Token: "token", Support: model.SupportInvalid}, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := rcisession.NewService(&assemblySessionStore{document: model.Document{Controller: test.controller}}, nil)
			assembly := &rciSessionAssembly{service: service}
			if got := assembly.ControllerPermissionAvailable(); got != test.want {
				t.Fatalf("ControllerPermissionAvailable() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPermissionChangedReportsOnlyFocusedStartFailure(t *testing.T) {
	root := t.TempDir()
	if _, err := manifest.ValidateV3(servicePermissionManifest("good")); err != nil {
		t.Fatalf("service manifest: %v", err)
	}
	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	runtimeRoot, err := os.MkdirTemp("/tmp", "rci-assembly-")
	if err != nil {
		t.Fatalf("runtime root: %v", err)
	}
	defer os.RemoveAll(runtimeRoot)
	if err := os.WriteFile(filepath.Join(runtimeRoot, "bad"), []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("blocked runtime path: %v", err)
	}
	if err := store.Mutate(func(st *state.State) error {
		for _, name := range []string{"bad", "good"} {
			st.Plugins[name] = &state.Plugin{
				Name:     name,
				Source:   state.SourceUpload,
				Approval: state.ApprovalApproved,
				Enabled:  true,
				Manifest: servicePermissionManifest(name),
			}
		}
		st.PermissionGrants = map[string]map[string]bool{
			"bad":  {manifest.PersistentRCISessionPermission: true},
			"good": {manifest.PersistentRCISessionPermission: true},
		}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	sessionStore := &assemblySessionStore{document: model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported},
	}}
	service := rcisession.NewService(sessionStore, nil)
	reconciler := socket.NewReconciler(socket.Config{DrainTimeout: 100 * time.Millisecond}, service)
	pluginRegistry := registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins"))
	if plugins := pluginRegistry.AllBackendPlugins(); len(plugins) != 2 {
		t.Fatalf("backend plugins = %d, want 2", len(plugins))
	}
	if !store.HasGrant("good", manifest.PersistentRCISessionPermission) || !store.HasGrant("bad", manifest.PersistentRCISessionPermission) {
		t.Fatalf("seeded grants = %#v", store.Snapshot().PermissionGrants)
	}
	assembly := &rciSessionAssembly{
		registry:    pluginRegistry,
		store:       store,
		runtimeRoot: runtimeRoot,
		service:     service,
		reconciler:  reconciler,
	}
	defer assembly.close()

	if err := assembly.PermissionChanged("bad"); !errors.Is(err, mgmt.ErrPersistentRCISocketStart) {
		t.Fatalf("bad permission change error = %v, want focused socket-start error", err)
	}
	goodPath, err := backend.NewRuntimePaths(runtimeRoot, "good")
	if err != nil {
		t.Fatalf("good runtime paths: %v", err)
	}
	if _, err := os.Stat(goodPath.RCISessionSocket); err != nil {
		t.Fatalf("good socket missing after unrelated failure: %v", err)
	}
	if err := assembly.PermissionChanged("good"); err != nil {
		t.Fatalf("good permission change leaked bad failure: %v", err)
	}

	sessionStore.document.Controller = nil
	assembly.reconcileSockets()
	if _, err := os.Stat(goodPath.RCISessionSocket); !os.IsNotExist(err) {
		t.Fatalf("good socket after session removal = %v", err)
	}
}

func servicePermissionManifest(name string) []byte {
	return []byte(`{"manifestVersion":3,"name":"` + name + `","version":"1.0.0","type":"page","label":"` + name + `","entry":"index.js","route":"/` + name + `","permissions":["persistent-rci-session"],"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`)
}

type assemblySessionStore struct {
	document model.Document
}

func (s *assemblySessionStore) State() model.StoreState { return model.StateOK }

func (s *assemblySessionStore) Snapshot() (model.Document, error) {
	document := model.Document{Extenders: make(map[string]model.TokenRecord)}
	if s.document.Controller != nil {
		controller := *s.document.Controller
		document.Controller = &controller
	}
	for identity, record := range s.document.Extenders {
		document.Extenders[identity] = record
	}

	return document, nil
}

func (s *assemblySessionStore) ReplaceController(record model.TokenRecord) error {
	s.document.Controller = &record

	return nil
}

func (s *assemblySessionStore) DeleteController() error {
	s.document.Controller = nil
	s.document.Extenders = make(map[string]model.TokenRecord)

	return nil
}

func (s *assemblySessionStore) UpsertExtender(identity string, record model.TokenRecord) error {
	if s.document.Extenders == nil {
		s.document.Extenders = make(map[string]model.TokenRecord)
	}
	s.document.Extenders[identity] = record

	return nil
}

func (s *assemblySessionStore) DeleteExtender(identity string) error {
	delete(s.document.Extenders, identity)

	return nil
}

func (s *assemblySessionStore) DeleteExtenders() error {
	s.document.Extenders = make(map[string]model.TokenRecord)

	return nil
}
