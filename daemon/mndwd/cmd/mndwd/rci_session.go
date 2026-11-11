package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/coordinator"
	"mndwd/internal/rcisession/establisher"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/sessionmanager"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	rcisessionstore "mndwd/internal/rcisession/store"
)

type rciSessionAssembly struct {
	close                func()
	err                  error
	permissionController mgmt.PersistentRCIPermissionController
	service              *rcisession.Service
	lifetime             context.Context
}

// assembleRCISession wires the persistent RCI session subsystem: it opens the
// encrypted store (falling back to a disabled store when that fails), builds the
// device HTTP client, service, socket reconciler, and coordinator, registers the
// RCI routes on accessMux, and returns cleanup plus a startup error when the
// service cannot be constructed.
func assembleRCISession(core daemonCore, accessMux *http.ServeMux, activationPoke func()) rciSessionAssembly {
	cfg, store, logger := core.cfg, core.store, core.logger
	registration := rciSessionAssembly{close: func() {}}

	persistentStore, storeErr := rcisessionstore.Open(rcisessionstore.Config{
		CiphertextFile: cfg.RCISessionCiphertextFile(),
		KeyFile:        cfg.RCISessionKeyFile(),
	})

	if storeErr != nil {
		logger.Error("persistent RCI store unavailable", "reason", "store-open-failed", "error", storeErr)

		persistentStore = rcisessionstore.Disabled()
	}

	deviceClient := &http.Client{
		Timeout:       cfg.RCIProxyOperationTimeout,
		CheckRedirect: httpx.NoRedirect,
	}
	// The session keeps its own lifetime rather than core.lifetime: in-flight
	// requests still proxy through it while the HTTP server drains after the
	// shutdown signal, and components.Close stops it explicitly afterwards.
	lifetime, cancel := context.WithCancel(context.Background())
	manager := sessionmanager.New(sessionmanager.Options{Context: lifetime})
	detector := &rcisession.AuthModeDetector{Client: deviceClient, BaseURL: cfg.ControllerURL, Timeout: rciAuthModeProbeTimeout}
	sessionService, serviceErr := rcisession.NewService(rcisession.ServiceConfig{
		Store:            persistentStore,
		HTTPClient:       deviceClient,
		ControllerURL:    cfg.ControllerURL,
		MaxResponseBytes: cfg.RCIProxyMaxResponseBytes,
		OperationTimeout: cfg.RCIProxyOperationTimeout,
		EnumerationTTL:   cfg.RCIEnumerationTTL,
		Manager:          manager,
		EnabledStore:     store,
		AuthModeSource:   detector,
		Logger:           logger,
	})

	if serviceErr != nil {
		cancel()

		registration.err = fmt.Errorf("persistent RCI service: %w", serviceErr)

		return registration
	}

	controllerTester := rcisession.ControllerHTTPTester{Client: deviceClient, Timeout: cfg.RCIProxyOperationTimeout, BaseURL: cfg.ControllerURL}

	rciMux := http.NewServeMux()

	rcisession.NewHandler(sessionService, controllerTester).Register(rciMux)
	accessMux.Handle("/api/mndw/rci-session/", rcisession.BodyLimit(4096)(rciMux))

	socketReconciler := rcisessionsocket.NewReconciler(rcisessionsocket.Config{
		Logger:      logger,
		MaxInflight: cfg.RCIProxyMaxInflight,
		IdleTimeout: cfg.RCIProxyIdleTimeout,
	}, sessionService)

	sessionService.DetectAuthMode(core.lifetime)

	sessionCoordinator := coordinator.New(coordinator.Config{
		Registry:          core.reg,
		Store:             store,
		RuntimeRoot:       cfg.PluginRuntimeRoot,
		Service:           sessionService,
		Establisher:       establisher.Establisher{AuthURLer: sessionService, HTTPClient: deviceClient, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		Heartbeat:         heartbeat.Probe{Timeout: rciHeartbeatTimeout, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		Reconciler:        socketReconciler,
		HeartbeatInterval: cfg.RCIHeartbeatInterval,
		Logger:            logger,
		Parent:            lifetime,
		ActivationPoke:    activationPoke,
	})

	sessionCoordinator.RegisterActivationGates(core.activationGates)
	sessionCoordinator.Start()

	registration.close = func() {
		sessionCoordinator.Close()
		cancel()
	}
	registration.permissionController = sessionCoordinator
	registration.service = sessionService
	registration.lifetime = lifetime

	return registration
}

const rciHeartbeatTimeout = 5 * time.Second
const rciAuthModeProbeTimeout = 5 * time.Second

// reconcileBackends returns the coordinator's synchronous activation poke.
// Supervisor.Start makes no controller-RCI call, so reconciliation cannot
// re-enter the coordinator while it handles a service mutation.
func reconcileBackends(core daemonCore) func() {
	return func() {
		core.runtime.Reconcile(core.lifetime, core.reg.AllBackendPlugins())
	}
}
