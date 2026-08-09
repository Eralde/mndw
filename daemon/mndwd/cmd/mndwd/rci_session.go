package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"mndw.local/device-auth"
	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// rciSessionAssembly owns the persistent-RCI socket bindings and their
// reconciliation with the encrypted credential state.
type rciSessionAssembly struct {
	registry    *registry.Registry
	store       *state.Store
	runtimeRoot string
	service     *rcisession.Service
	reconciler  *rcisessionsocket.Reconciler
	logger      *slog.Logger
	mu          sync.Mutex
}

type persistentSessionRegistration struct {
	close                func()
	permissionController mgmt.PersistentRCIPermissionController
}

// assembleRCISession wires the persistent RCI session subsystem: it opens the
// encrypted store, builds the device HTTP client, enumerator, service, token
// generator, and socket reconciler, registers the RCI routes on accessMux, and
// returns the cleanup that closes the socket reconciler. When the persistent
// store cannot be opened the subsystem is skipped and the returned cleanup is a
// no-op.
func assembleRCISession(cfg Config, store *state.Store, reg *registry.Registry, runtimeRoot string, accessMux *http.ServeMux, logger *slog.Logger) persistentSessionRegistration {
	registration := persistentSessionRegistration{close: func() {}}

	if cfg.RCISessionStateDir == "" {
		cfg.RCISessionStateDir = cfg.DataDir
	}

	if cfg.RCISessionKeyDir == "" {
		cfg.RCISessionKeyDir = filepath.Join(filepath.Dir(cfg.DataDir), "rci-session-secrets")
	}

	persistentStore, storeErr := rcisessionstore.Open(rcisessionstore.Config{
		CiphertextFile: cfg.RCISessionCiphertextFile(),
		KeyFile:        cfg.RCISessionKeyFile(),
	})

	if storeErr != nil {
		logger.Error("persistent RCI store unavailable", "error", storeErr)

		return registration
	}

	deviceClient := &http.Client{
		Timeout: cfg.RCIProxyOperationTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	enumerator := enumeration.NewCache(enumeration.HTTPSource{
		Client:           deviceClient,
		ControllerURL:    cfg.ControllerURL,
		MaxResponseBytes: cfg.RCIProxyMaxResponseBytes,
		ControllerToken: func() string {
			document, err := persistentStore.Snapshot()
			if err != nil || document.Controller == nil || document.Controller.Support == model.SupportInvalid {
				return ""
			}

			return document.Controller.Token
		},
	}, cfg.RCIEnumerationTTL, time.Now)
	sessionService := rcisession.NewService(persistentStore, enumerator)

	sessionService.SetLogger(logger)

	if err := sessionService.SetControllerURL(cfg.ControllerURL, cfg.Dev); err != nil {
		logger.Error("persistent RCI controller URL rejected", "error", err)
	}

	controllerTester := rcisession.ControllerHTTPTester{Client: deviceClient, Timeout: cfg.RCIProxyOperationTimeout, BaseURL: cfg.ControllerURL}
	authTransport := auth.NewHTTPTransport(deviceClient)
	generator := minter.HTTPGenerator{
		Authenticator:    auth.New(auth.Options{Transport: authTransport, AuthTimeout: cfg.RCIProxyOperationTimeout}),
		Transport:        authTransport,
		RequestBody:      minter.DefaultRequestBody,
		TokenRequestBody: minter.DefaultTokenRequestBody,
		Logger:           logger,
	}

	rcisession.NewHandler(sessionService, controllerTester, generator).Register(accessMux)
	sessionService.Proxy(deviceClient, cfg.RCIProxyMaxResponseBytes, cfg.RCIProxyOperationTimeout)

	socketReconciler := rcisessionsocket.NewReconciler(rcisessionsocket.Config{
		Logger:      logger,
		MaxInflight: cfg.RCIProxyMaxInflight,
		IdleTimeout: cfg.RCIProxyIdleTimeout,
	}, sessionService)
	assembly := &rciSessionAssembly{
		registry:    reg,
		store:       store,
		runtimeRoot: runtimeRoot,
		service:     sessionService,
		reconciler:  socketReconciler,
		logger:      logger,
	}

	sessionService.SetMutationObserver(assembly.reconcileSockets)
	assembly.reconcileSockets()

	registration.close = assembly.close
	registration.permissionController = assembly

	return registration
}

func (a *rciSessionAssembly) reconcileSockets() {
	a.mu.Lock()

	defer a.mu.Unlock()

	report, err := a.reconcileSocketsLocked()
	if err != nil {
		a.serviceLogger().Error("persistent RCI socket reconciliation failed", "reason", "reconcile", "error", err)
	}

	for plugin := range report.StartErrors {
		a.serviceLogger().Error("persistent RCI socket start failed", "plugin", plugin, "reason", "reconcile")
	}
}

func (a *rciSessionAssembly) ControllerPermissionAvailable() bool {
	if a == nil || a.service == nil {
		return false
	}

	_, document := a.service.Capability()

	return document.Controller != nil && document.Controller.Support == model.SupportSupported
}

func (a *rciSessionAssembly) PermissionChanged(plugin string) error {
	if a == nil || a.service == nil || a.reconciler == nil {
		return nil
	}

	a.mu.Lock()

	defer a.mu.Unlock()

	report, err := a.reconcileSocketsLocked()
	if err != nil {
		return err
	}

	if report.Desired[plugin] && !report.Active[plugin] {
		return fmt.Errorf("%w: plugin %s socket unavailable", mgmt.ErrPersistentRCISocketStart, plugin)
	}

	return nil
}

func (a *rciSessionAssembly) close() {
	a.mu.Lock()

	defer a.mu.Unlock()

	if a.reconciler != nil {
		a.reconciler.Close()
	}
}

func (a *rciSessionAssembly) reconcileSocketsLocked() (rcisessionsocket.ReconcileReport, error) {
	bindings := make([]rcisessionsocket.Binding, 0)

	for _, plugin := range a.registry.AllBackendPlugins() {
		if !hasPersistentRCIPermission(plugin.Manifest) {
			continue
		}

		if !isService(plugin.Manifest) {
			continue
		}

		grants := rcisessionsocket.Grants{
			CanRead:  a.store.HasGrant(plugin.Name, manifest.PersistentRCISessionReadPermission),
			CanWrite: a.store.HasGrant(plugin.Name, manifest.PersistentRCISessionWritePermission),
		}
		grants.CanRead = grants.CanRead || grants.CanWrite

		if !grants.CanRead && !grants.CanWrite {
			continue
		}

		paths, err := backend.NewRuntimePaths(a.runtimeRoot, plugin.Name)
		if err == nil && paths.RCISessionSocket != "" {
			bindings = append(bindings, rcisessionsocket.Binding{
				PluginID: plugin.Name,
				Path:     paths.RCISessionSocket,
				Grants:   grants,
			})
		}
	}

	_, document := a.service.Capability()
	present := document.Controller != nil && document.Controller.Token != ""

	return a.reconciler.Reconcile(context.Background(), bindings, present)
}

func (a *rciSessionAssembly) serviceLogger() *slog.Logger {
	if a.logger != nil {
		return a.logger
	}

	return slog.Default()
}

func isService(m *manifest.Manifest) bool {
	return m != nil && m.Backend != nil && m.Backend.Kind != nil && *m.Backend.Kind == manifest.BackendKindService && m.Backend.ProtocolVersion != nil && *m.Backend.ProtocolVersion == 1
}

func hasPersistentRCIPermission(m *manifest.Manifest) bool {
	if m == nil {
		return false
	}

	for _, permission := range m.Permissions {
		if manifest.IsPersistentRCIPermission(permission) {
			return true
		}
	}

	return false
}
