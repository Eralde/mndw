package coordinator

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/sessionmanager"
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
			service := newCoordinatorService(t, rcisession.ServiceConfig{Store: &assemblySessionStore{document: model.Document{Controller: test.controller}}})
			assembly := &Coordinator{service: service}

			if got := assembly.ControllerPermissionAvailable(); got != test.want {
				t.Fatalf("ControllerPermissionAvailable() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestControllerPermissionAvailableTokenless(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		service := newCoordinatorService(t, rcisession.ServiceConfig{
			Store:          &assemblySessionStore{},
			AuthModeSource: &coordinatorAuthModeSource{mode: rcisession.AuthModeNone},
			EnabledStore:   &coordinatorEnabledStore{enabled: enabled, set: true},
		})
		assembly := &Coordinator{service: service}

		if got := assembly.ControllerPermissionAvailable(); got != enabled {
			t.Fatalf("ControllerPermissionAvailable() with enabled=%t = %t", enabled, got)
		}
	}
}

func TestReconcileSocketsOpensForTokenlessEnabled(t *testing.T) {
	assembly, _ := newSocketAssemblyWithServiceConfig(t, rcisession.ServiceConfig{
		AuthModeSource: &coordinatorAuthModeSource{mode: rcisession.AuthModeNone},
		EnabledStore:   &coordinatorEnabledStore{enabled: true, set: true},
	})

	assembly.ReconcileSockets()

	paths, err := backend.NewRuntimePaths(assembly.runtimeRoot, "demo")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.RCISessionSocket); err != nil {
		t.Fatalf("tokenless socket was not opened: %v", err)
	}

	if blockers := assembly.ActivationBlockers("demo", manifest.PersistentRCISessionReadPermission); len(blockers) != 0 {
		t.Fatalf("tokenless activation blockers = %#v", blockers)
	}
}

func TestReconcileSocketsClosesWhenTokenlessDisabled(t *testing.T) {
	manager := sessionmanager.New()

	manager.ApplyEnumeration([]enumeration.Member{{Identity: "node", IP: "192.0.2.1", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true}})

	ctx, epoch, ok := manager.BeginEstablishment("node", manager.Epoch())

	if !ok {
		t.Fatal("BeginEstablishment() did not start")
	}

	_ = ctx
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}

	generation := manager.Snapshot().Member("node").Generation

	if !manager.CommitEstablishment("node", epoch, generation, sessionmanager.Candidate{BaseURL: "https://node.keenetic.io", Jar: jar, Client: &http.Client{}}) {
		t.Fatal("CommitEstablishment() did not commit")
	}

	assembly, _ := newSocketAssemblyWithServiceConfig(t, rcisession.ServiceConfig{
		Manager:        manager,
		AuthModeSource: &coordinatorAuthModeSource{mode: rcisession.AuthModeNone},
		EnabledStore:   &coordinatorEnabledStore{enabled: true, set: true},
	})

	assembly.ReconcileSockets()

	paths, err := backend.NewRuntimePaths(assembly.runtimeRoot, "demo")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.RCISessionSocket); err != nil {
		t.Fatalf("tokenless socket was not opened: %v", err)
	}

	_, err = assembly.service.SetTokenlessEnabled(context.Background(), nil, false)
	if err != nil {
		t.Fatalf("SetTokenlessEnabled(false): %v", err)
	}

	if _, err := os.Stat(paths.RCISessionSocket); !os.IsNotExist(err) {
		t.Fatalf("socket after disabling tokenless session = %v, want absent", err)
	}

	if targets := manager.LiveHeartbeatTargets(); len(targets) != 0 {
		t.Fatalf("heartbeat targets after disabling = %#v, want none", targets)
	}
}

func TestTickDetectsUnknownAuthModeOutsideLock(t *testing.T) {
	source := &coordinatorAuthModeSource{mode: rcisession.AuthModeUnknown}
	manager := sessionmanager.New()
	serviceConfig := rcisession.ServiceConfig{
		Manager:        manager,
		Enumerator:     enumeration.NewCache(coordinatorEnumerationSource{}, time.Minute, time.Now),
		EnabledStore:   &coordinatorEnabledStore{enabled: true, set: true},
		AuthModeSource: source,
	}
	assembly, _ := newSocketAssemblyWithServiceConfig(t, serviceConfig)
	assembly.lifetime = context.Background()
	source.detect = func(context.Context) rcisession.AuthMode {
		if !assembly.mu.TryLock() {
			t.Fatal("auth mode detection ran while coordinator mutex was held")
		}

		assembly.mu.Unlock()

		source.mode = rcisession.AuthModeNone

		return source.mode
	}

	assembly.tick()

	paths, err := backend.NewRuntimePaths(assembly.runtimeRoot, "demo")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(paths.RCISessionSocket); err != nil {
		t.Fatalf("socket after unknown mode detection = %v", err)
	}
}

type coordinatorAuthModeSource struct {
	mode   rcisession.AuthMode
	detect func(context.Context) rcisession.AuthMode
}

type coordinatorEnumerationSource struct{}

func (coordinatorEnumerationSource) Enumerate(context.Context) ([]enumeration.Member, error) {
	return nil, nil
}

func (s *coordinatorAuthModeSource) Mode() rcisession.AuthMode { return s.mode }

func (s *coordinatorAuthModeSource) Detect(ctx context.Context) rcisession.AuthMode {
	if s.detect != nil {
		return s.detect(ctx)
	}

	return s.mode
}

type coordinatorEnabledStore struct {
	enabled bool
	set     bool
}

func (s *coordinatorEnabledStore) PersistentRCIEnabled() (bool, bool) { return s.enabled, s.set }

func (s *coordinatorEnabledStore) SetPersistentRCIEnabled(enabled bool) error {
	s.enabled = enabled
	s.set = true

	return nil
}

func TestPermissionChangedReportsOnlyFocusedStartFailure(t *testing.T) {
	root := t.TempDir()

	if _, err := manifest.Validate(servicePermissionManifest("good")); err != nil {
		t.Fatalf("service manifest: %v", err)
	}

	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	runtimeRoot := shortTempDir(t)

	if err := os.WriteFile(filepath.Join(runtimeRoot, "bad"), []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("blocked runtime path: %v", err)
	}

	skipUnixSocketUnavailable(t, runtimeRoot)

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
			"bad":  {manifest.PersistentRCISessionWritePermission: true},
			"good": {manifest.PersistentRCISessionWritePermission: true},
		}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	sessionStore := &assemblySessionStore{document: model.Document{
		Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported},
	}}
	service := newCoordinatorService(t, rcisession.ServiceConfig{Store: sessionStore})
	reconciler := socket.NewReconciler(socket.Config{DrainTimeout: 100 * time.Millisecond}, service)
	pluginRegistry := registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins"))

	if plugins := pluginRegistry.AllBackendPlugins(); len(plugins) != 2 {
		t.Fatalf("backend plugins = %d, want 2", len(plugins))
	}

	if !store.HasGrant("good", manifest.PersistentRCISessionWritePermission) || !store.HasGrant("bad", manifest.PersistentRCISessionWritePermission) {
		t.Fatalf("seeded grants = %#v", store.Snapshot().PermissionGrants)
	}

	assembly := &Coordinator{
		registry:    pluginRegistry,
		store:       store,
		runtimeRoot: runtimeRoot,
		service:     service,
		reconciler:  reconciler,
	}

	defer assembly.Close()

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

	assembly.ReconcileSockets()

	if _, err := os.Stat(goodPath.RCISessionSocket); !os.IsNotExist(err) {
		t.Fatalf("good socket after session removal = %v", err)
	}
}

func skipUnixSocketUnavailable(t *testing.T, root string) {
	t.Helper()

	listener, err := net.Listen("unix", filepath.Join(root, "socket-probe"))
	if err == nil {
		_ = listener.Close()

		return
	}

	if strings.Contains(err.Error(), "operation not permitted") {
		t.Skipf("Unix listener unavailable in test environment: %v", err)
	}

	t.Fatalf("probe Unix listener: %v", err)
}

// shortTempDir returns a directory under /tmp. macOS caps Unix socket paths at
// 104 bytes, and t.TempDir() paths are longer than that.
func shortTempDir(t *testing.T) string {
	t.Helper()

	dir, err := os.MkdirTemp("/tmp", "mndw-coord-")
	if err != nil {
		t.Fatalf("short temp dir: %v", err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	return dir
}

func TestActivationEvaluateReportsBothBlockersBeforeFirstPublish(t *testing.T) {
	assembly := &Coordinator{}

	got := assembly.ActivationBlockers("demo", manifest.PersistentRCISessionWritePermission)
	want := []backend.ActivationBlocker{
		{Permission: manifest.PersistentRCISessionWritePermission, Reason: backend.BlockerNotGranted},
		{Permission: manifest.PersistentRCISessionWritePermission, Reason: backend.BlockerPrerequisiteUnavailable, Prerequisite: "controller-token"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ActivationBlockers() = %#v, want %#v", got, want)
	}
}

func TestActivationSnapshotUsesGrantUnionAndTokenPresence(t *testing.T) {
	tests := []struct {
		name       string
		readGrant  bool
		writeGrant bool
		controller *model.TokenRecord
		want       bool
	}{
		{name: "no controller", readGrant: true, want: false},
		{name: "empty token", writeGrant: true, controller: &model.TokenRecord{}, want: false},
		{name: "read grant", readGrant: true, controller: &model.TokenRecord{Token: "token", Support: model.SupportSupported}, want: true},
		{name: "write grant", writeGrant: true, controller: &model.TokenRecord{Token: "token", Support: model.SupportSupported}, want: true},
		{name: "both grants", readGrant: true, writeGrant: true, controller: &model.TokenRecord{Token: "token", Support: model.SupportSupported}, want: true},
		{name: "no grant", controller: &model.TokenRecord{Token: "token", Support: model.SupportSupported}, want: false},
		{name: "invalid support retains token", writeGrant: true, controller: &model.TokenRecord{Token: "token", Support: model.SupportInvalid}, want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assembly := newActivationSnapshotAssembly(t, map[string]bool{
				manifest.PersistentRCISessionReadPermission:  test.readGrant,
				manifest.PersistentRCISessionWritePermission: test.writeGrant,
			})

			assembly.mu.Lock()

			service := newCoordinatorService(t, rcisession.ServiceConfig{Store: &assemblySessionStore{document: model.Document{Controller: test.controller}}})
			changed := assembly.publishActivationSnapshotLocked(service.SessionPresent())

			assembly.mu.Unlock()

			got := len(assembly.ActivationBlockers("demo", manifest.PersistentRCISessionReadPermission)) == 0

			if !changed || got != test.want {
				t.Fatalf("changed=%v satisfied=%v, want changed=true satisfied=%v", changed, got, test.want)
			}
		})
	}
}

func TestActivationEvaluateAppliesReadWriteGrantSemantics(t *testing.T) {
	tests := []struct {
		name       string
		readGrant  bool
		writeGrant bool
		controller *model.TokenRecord
		permission string
		want       []backend.ActivationBlocker
	}{
		{name: "read missing grant and token", permission: manifest.PersistentRCISessionReadPermission, want: []backend.ActivationBlocker{
			{Permission: manifest.PersistentRCISessionReadPermission, Reason: backend.BlockerNotGranted},
			{Permission: manifest.PersistentRCISessionReadPermission, Reason: backend.BlockerPrerequisiteUnavailable, Prerequisite: "controller-token"},
		}},
		{name: "read grant missing token", readGrant: true, permission: manifest.PersistentRCISessionReadPermission, want: []backend.ActivationBlocker{
			{Permission: manifest.PersistentRCISessionReadPermission, Reason: backend.BlockerPrerequisiteUnavailable, Prerequisite: "controller-token"},
		}},
		{name: "read accepts write grant", writeGrant: true, controller: &model.TokenRecord{Token: "token"}, permission: manifest.PersistentRCISessionReadPermission},
		{name: "write rejects read grant", readGrant: true, controller: &model.TokenRecord{Token: "token"}, permission: manifest.PersistentRCISessionWritePermission, want: []backend.ActivationBlocker{
			{Permission: manifest.PersistentRCISessionWritePermission, Reason: backend.BlockerNotGranted},
		}},
		{name: "write accepts write grant", writeGrant: true, controller: &model.TokenRecord{Token: "token"}, permission: manifest.PersistentRCISessionWritePermission},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assembly := newActivationSnapshotAssembly(t, map[string]bool{
				manifest.PersistentRCISessionReadPermission:  test.readGrant,
				manifest.PersistentRCISessionWritePermission: test.writeGrant,
			})

			assembly.mu.Lock()

			service := newCoordinatorService(t, rcisession.ServiceConfig{Store: &assemblySessionStore{document: model.Document{Controller: test.controller}}})

			assembly.publishActivationSnapshotLocked(service.SessionPresent())
			assembly.mu.Unlock()

			got := assembly.ActivationBlockers("demo", test.permission)

			if len(got) != len(test.want) || (len(got) > 0 && !reflect.DeepEqual(got, test.want)) {
				t.Fatalf("ActivationBlockers() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestActivationPokeRunsOnlyAfterSnapshotDeltaAndOutsideAssemblyMutex(t *testing.T) {
	assembly, sessionStore := newSocketAssembly(t)
	var calls atomic.Int32
	called := make(chan struct{})

	assembly.activationPoke = func() {
		assembly.mu.Lock()
		assembly.mu.Unlock()

		if calls.Add(1) == 1 {
			close(called)
		}
	}

	sessionStore.document.Controller = &model.TokenRecord{Token: "present", Support: model.SupportInvalid}

	assembly.ReconcileSockets()

	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("delta did not invoke activation poke")
	}

	assembly.ReconcileSockets()
	assembly.ReconcileSockets()

	if got := calls.Load(); got != 1 {
		t.Fatalf("unchanged snapshots invoked poke %d times, want 1", got)
	}

	assembly.service.Unauthorized("controller", assembly.service.ControllerEpoch())
	assembly.service.Unauthorized("controller", assembly.service.ControllerEpoch())

	if got := calls.Load(); got != 1 {
		t.Fatalf("retained-token Unauthorized events invoked poke %d times, want 1", got)
	}
}

func TestNewSubscribesToServiceMutations(t *testing.T) {
	var pokes atomic.Int32
	assembly, service := newStartedCoordinator(t, func() { pokes.Add(1) })

	if err := service.DeleteController(); err != nil {
		t.Fatal(err)
	}

	if got := pokes.Load(); got != 1 {
		t.Fatalf("controller deletion pokes = %d, want 1 before return", got)
	}

	blockers := assembly.ActivationBlockers("demo", manifest.PersistentRCISessionWritePermission)

	if len(blockers) != 1 || blockers[0].Prerequisite != "controller-token" {
		t.Fatalf("activation blockers after deletion = %#v, want controller-token blocker", blockers)
	}
}

func TestStartPublishesInitialSnapshotWithoutPoke(t *testing.T) {
	var pokes atomic.Int32
	assembly, _ := newStartedCoordinator(t, func() { pokes.Add(1) })

	if blockers := assembly.ActivationBlockers("demo", manifest.PersistentRCISessionWritePermission); len(blockers) != 0 {
		t.Fatalf("initial activation blockers = %#v, want none", blockers)
	}

	if got := pokes.Load(); got != 0 {
		t.Fatalf("initial snapshot pokes = %d, want 0", got)
	}
}

func TestCloseCancelsOwnContextNotParent(t *testing.T) {
	parent := context.Background()
	assembly := New(Config{Parent: parent})

	assembly.Start()
	assembly.Close()

	if err := parent.Err(); err != nil {
		t.Fatalf("parent context after Close = %v, want nil", err)
	}
}

func TestParentCancelStopsLoop(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	assembly := New(Config{Parent: parent})

	assembly.Start()
	cancel()

	done := make(chan struct{})

	go func() {
		assembly.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close after parent cancellation blocked")
	}
}

func newStartedCoordinator(t *testing.T, poke func()) (*Coordinator, *rcisession.Service) {
	t.Helper()

	root := shortTempDir(t)

	skipUnixSocketUnavailable(t, root)

	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name: "demo", Source: state.SourceUpload, Approval: state.ApprovalApproved, Enabled: true,
			Manifest: servicePermissionManifest("demo"),
		}
		st.PermissionGrants = map[string]map[string]bool{
			"demo": {manifest.PersistentRCISessionWritePermission: true},
		}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	sessionStore := &assemblySessionStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller-token", Support: model.SupportSupported}}}
	service := newCoordinatorService(t, rcisession.ServiceConfig{Store: sessionStore, Enumerator: &activationEnumerator{}})
	reconciler := socket.NewReconciler(socket.Config{DrainTimeout: 100 * time.Millisecond}, service)
	assembly := New(Config{
		Registry:       registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins")),
		Store:          store,
		RuntimeRoot:    filepath.Join(root, "runtime"),
		Service:        service,
		Reconciler:     reconciler,
		ActivationPoke: poke,
	})

	assembly.Start()
	t.Cleanup(assembly.Close)

	return assembly, service
}

func newActivationSnapshotAssembly(t *testing.T, grants map[string]bool) *Coordinator {
	t.Helper()

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: servicePermissionManifest("demo"),
		}
		st.PermissionGrants = map[string]map[string]bool{"demo": grants}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	pluginRegistry := registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins"))
	service := newCoordinatorService(t, rcisession.ServiceConfig{Store: &assemblySessionStore{}, Enumerator: &activationEnumerator{}})

	return &Coordinator{registry: pluginRegistry, store: store, service: service}
}

func newCoordinatorService(t *testing.T, cfg rcisession.ServiceConfig) *rcisession.Service {
	t.Helper()

	service, err := rcisession.NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}

	return service
}

func newSocketAssembly(t *testing.T) (*Coordinator, *assemblySessionStore) {
	return newSocketAssemblyWithServiceConfig(t, rcisession.ServiceConfig{})
}

func newSocketAssemblyWithServiceConfig(t *testing.T, serviceConfig rcisession.ServiceConfig) (*Coordinator, *assemblySessionStore) {
	t.Helper()

	root := shortTempDir(t)

	skipUnixSocketUnavailable(t, root)

	store, err := state.Open(filepath.Join(root, "state", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: servicePermissionManifest("demo"),
		}
		st.PermissionGrants = map[string]map[string]bool{
			"demo": {manifest.PersistentRCISessionWritePermission: true},
		}

		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	sessionStore := &assemblySessionStore{}
	serviceConfig.Store = sessionStore

	if serviceConfig.Enumerator == nil {
		serviceConfig.Enumerator = &activationEnumerator{}
	}

	service := newCoordinatorService(t, serviceConfig)
	reconciler := socket.NewReconciler(socket.Config{DrainTimeout: 100 * time.Millisecond}, service)
	assembly := &Coordinator{
		registry:    registry.New(store, filepath.Join(root, "plugins"), filepath.Join(root, "builtins")),
		store:       store,
		runtimeRoot: filepath.Join(root, "runtime"),
		service:     service,
		manager:     service.SessionManager(),
		enumerator:  service.Enumerator(),
		reconciler:  reconciler,
	}

	service.SubscribeMutations(assembly.ReconcileSockets)
	assembly.ReconcileSockets()
	t.Cleanup(assembly.Close)

	return assembly, sessionStore
}

type activationEnumerator struct{}

func (e *activationEnumerator) List(context.Context) ([]enumeration.Member, error) {
	return nil, nil
}

func (e *activationEnumerator) Invalidate() {}

func servicePermissionManifest(name string) []byte {
	return []byte(`{"manifestVersion":1,"name":"` + name + `","version":"1.0.0","type":"page","label":"` + name + `","entry":"index.js","route":"/` + name + `","permissions":["persistent-rci-session:write"],"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`)
}

type assemblySessionStore struct {
	document model.Document
}

func (s *assemblySessionStore) State() model.StoreState { return model.StateOK }

func (s *assemblySessionStore) Snapshot() (model.Document, error) {
	if s.document.Controller != nil {
		controller := *s.document.Controller

		return model.Document{Controller: &controller}, nil
	}

	return model.Document{}, nil
}

func (s *assemblySessionStore) ReplaceController(record model.TokenRecord) error {
	s.document.Controller = &record

	return nil
}

func (s *assemblySessionStore) DeleteController() error {
	s.document.Controller = nil

	return nil
}

func TestCloseWithoutStartReturns(t *testing.T) {
	parent := context.Background()
	coordinator := New(Config{Parent: parent})

	done := make(chan struct{})

	go func() {
		coordinator.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close without Start blocked")
	}
}

func TestNewDefaultsHeartbeatInterval(t *testing.T) {
	coordinator := New(Config{})

	if got := coordinator.heartbeatEvery; got != DefaultHeartbeatInterval {
		t.Fatalf("heartbeatEvery = %s, want %s", got, DefaultHeartbeatInterval)
	}

	coordinator.Close()
}

// TestStartThenCloseWithOmittedLifetimeReturns runs the real loop (Enumerator
// set, so Start's Poke triggers a tick) with no caller-supplied lifetime, and
// requires Close to cancel the context New created for itself.
func TestStartThenCloseWithOmittedLifetimeReturns(t *testing.T) {
	coordinator := New(Config{
		Service: newCoordinatorService(t, rcisession.ServiceConfig{
			Store:      &assemblySessionStore{},
			Enumerator: enumeration.NewCache(enumeration.HTTPSource{}, time.Minute, time.Now),
		}),
	})

	coordinator.Start()

	done := make(chan struct{})

	go func() {
		coordinator.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close after Start blocked: the reconcile loop was never cancelled")
	}
}
