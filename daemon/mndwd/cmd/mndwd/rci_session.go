package main

import (
	"context"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"mndw.local/device-auth"
	"mndwd/internal/manifest"
	"mndwd/internal/pluginruntime"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
	"mndwd/internal/rcisession/model"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/registry"
)

// rciSessionAssembly owns the persistent-RCI socket bindings and their
// reconciliation with the encrypted credential state.
type rciSessionAssembly struct {
	registry    *registry.Registry
	runtimeRoot string
	service     *rcisession.Service
	reconciler  *rcisessionsocket.Reconciler
}

// assembleRCISession wires the persistent RCI session subsystem: it opens the
// encrypted store, builds the device HTTP client, enumerator, service, token
// generator, and socket reconciler, registers the RCI routes on accessMux, and
// returns the cleanup that closes the socket reconciler. When the persistent
// store cannot be opened the subsystem is skipped and the returned cleanup is a
// no-op.
func assembleRCISession(cfg Config, reg *registry.Registry, runtimeRoot string, accessMux *http.ServeMux, logger *slog.Logger) func() {
	closePersistentSession := func() {}

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

		return closePersistentSession
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
		runtimeRoot: runtimeRoot,
		service:     sessionService,
		reconciler:  socketReconciler,
	}
	sessionService.SetMutationObserver(assembly.reconcileSockets)
	assembly.reconcileSockets()
	closePersistentSession = socketReconciler.Close

	return closePersistentSession
}

func (a *rciSessionAssembly) reconcileSockets() {
	bindings := make([]rcisessionsocket.Binding, 0)
	for _, plugin := range a.registry.ListBuiltins() {
		if !hasPersistentRCIPermission(plugin.Manifest) {
			continue
		}
		runtimeDir, err := pluginruntime.Ensure(a.runtimeRoot, plugin.Name)
		if err != nil || runtimeDir == "" {
			continue
		}
		bindings = append(bindings, rcisessionsocket.Binding{PluginID: plugin.Name, Path: filepath.Join(runtimeDir, "rci-session.sock")})
	}
	_, document := a.service.Capability()
	present := document.Controller != nil && document.Controller.Token != ""
	_ = a.reconciler.Reconcile(context.Background(), bindings, present)
}

func hasPersistentRCIPermission(m *manifest.Manifest) bool {
	if m == nil {
		return false
	}
	for _, permission := range m.Permissions {
		if permission == manifest.PersistentRCISessionPermission {
			return true
		}
	}
	return false
}
