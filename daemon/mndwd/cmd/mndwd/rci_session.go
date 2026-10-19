package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/coordinator"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/establisher"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/sessionmanager"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/telemetry"
	"mndwd/internal/telemetry/annotations"
	"mndwd/internal/telemetry/clock"
)

type persistentSessionRegistration struct {
	close                func()
	err                  error
	permissionController mgmt.PersistentRCIPermissionController
	coordinator          *coordinator.Coordinator
	capability           *telemetry.Capability
	rciClient            *rci.Client
	eventRCIClient       *rci.Client
	annotationStore      *annotations.Store
}

func newTelemetryAndEventClients(do telemetry.DoFunc) (telemetryClient *rci.Client, eventClient *rci.Client, err error) {
	telemetryClient, err = rci.New(telemetry.NewControllerTransport(do))
	if err != nil {
		return nil, nil, fmt.Errorf("create telemetry RCI client: %w", err)
	}

	eventClient, err = rci.New(telemetry.NewControllerTransport(do))
	if err != nil {
		return nil, nil, fmt.Errorf("create event log RCI client: %w", err)
	}

	return telemetryClient, eventClient, nil
}

// assembleRCISession wires the persistent RCI session subsystem: it opens the
// encrypted store, builds the device HTTP client, enumerator, service, and
// socket reconciler, registers the RCI routes on accessMux, and returns cleanup
// plus a startup error when the persistent store cannot be opened.
func assembleRCISession(core daemonCore, accessMux *http.ServeMux) persistentSessionRegistration {
	cfg, store, logger := core.cfg, core.store, core.logger
	registration := persistentSessionRegistration{close: func() {}}

	persistentStore, storeErr := rcisessionstore.Open(rcisessionstore.Config{
		CiphertextFile: cfg.RCISessionCiphertextFile(),
		KeyFile:        cfg.RCISessionKeyFile(),
	})

	if storeErr != nil {
		logger.Error("persistent RCI store unavailable", "reason", "store-open-failed")

		registration.err = fmt.Errorf("open persistent RCI store: %w", storeErr)

		return registration
	}

	deviceClient := &http.Client{
		Timeout: cfg.RCIProxyOperationTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	var sessionService *rcisession.Service
	controllerSource := enumeration.HTTPSource{
		Client:           deviceClient,
		ControllerURL:    cfg.ControllerURL,
		MaxResponseBytes: cfg.RCIProxyMaxResponseBytes,
		CaptureController: func() enumeration.ControllerSnapshot {
			if sessionService == nil {
				return enumeration.ControllerSnapshot{}
			}

			return sessionService.CaptureController()
		},
		CurrentEpoch: func() uint64 {
			if sessionService == nil {
				return 0
			}

			return sessionService.ControllerEpoch()
		},
	}
	enumerator := enumeration.NewCache(controllerSource, cfg.RCIEnumerationTTL, time.Now)
	sessionService = rcisession.NewService(persistentStore, enumerator)

	sessionService.SetControllerClient(deviceClient)

	sessionService.SetLogger(logger)

	if err := sessionService.SetControllerURL(cfg.ControllerURL, cfg.Dev); err != nil {
		logger.Error("persistent RCI controller URL rejected", "error", err)
	}

	controllerTester := rcisession.ControllerHTTPTester{Client: deviceClient, Timeout: cfg.RCIProxyOperationTimeout, BaseURL: cfg.ControllerURL}
	// The session keeps its own lifetime rather than core.lifetime: in-flight
	// requests still proxy through it while the HTTP server drains after the
	// shutdown signal, and components.Close stops it explicitly afterwards.
	lifetime, cancel := context.WithCancel(context.Background())
	manager := sessionmanager.New(sessionmanager.Options{Context: lifetime})

	sessionService.SetSessionManager(manager)

	rciMux := http.NewServeMux()

	rcisession.NewHandler(sessionService, controllerTester).Register(rciMux)
	accessMux.Handle("/api/mndw/rci-session/", rcisession.BodyLimit(4096)(rciMux))
	sessionService.Proxy(deviceClient, cfg.RCIProxyMaxResponseBytes, cfg.RCIProxyOperationTimeout)

	socketReconciler := rcisessionsocket.NewReconciler(rcisessionsocket.Config{
		Logger:      logger,
		MaxInflight: cfg.RCIProxyMaxInflight,
		IdleTimeout: cfg.RCIProxyIdleTimeout,
	}, sessionService)
	sessionCoordinator, coordinatorErr := coordinator.New(coordinator.Config{
		Registry:          core.reg,
		Store:             store,
		RuntimeRoot:       cfg.PluginRuntimeRoot,
		Service:           sessionService,
		Enumerator:        enumerator,
		Manager:           manager,
		Establisher:       establisher.Establisher{AuthURLer: sessionService, HTTPClient: deviceClient, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		Heartbeat:         heartbeat.Probe{Timeout: rciHeartbeatTimeout, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		Reconciler:        socketReconciler,
		HeartbeatInterval: cfg.RCIHeartbeatInterval,
		Logger:            logger,
		Lifetime:          lifetime,
		Cancel:            cancel,
	})

	if coordinatorErr != nil {
		cancel()

		registration.err = fmt.Errorf("persistent RCI coordinator: %w", coordinatorErr)

		return registration
	}

	sessionCoordinator.RegisterActivationGates(core.activationGates)
	sessionService.SetMutationObserver(func() {
		sessionCoordinator.ReconcileSockets()
		sessionCoordinator.Poke()
	})
	sessionCoordinator.ReconcileSockets()
	sessionCoordinator.Start()

	registration.close = sessionCoordinator.Close
	registration.permissionController = sessionCoordinator
	registration.coordinator = sessionCoordinator
	telemetryClient, eventClient, rciErr := newTelemetryAndEventClients(sessionService.Do)

	if rciErr != nil {
		registration.err = rciErr

		return registration
	}

	registration.rciClient = telemetryClient
	registration.eventRCIClient = eventClient

	policy := telemetry.DefaultPolicy()

	if cfg.TelemetryMaxUnsynced > 0 {
		policy.MaxUnsynced = cfg.TelemetryMaxUnsynced
	}

	capability, capabilityErr := telemetry.NewCapability(telemetry.CapabilityConfig{
		RRDDir:             cfg.RRDDir,
		LoadSampler:        telemetry.NewLoadSampler(telemetryClient),
		TemperatureSampler: telemetry.NewThermalSampler(osThermalReader{}, "/sys/class/thermal"),
		Clock:              clock.NewBootClock(),
		Evidence:           telemetry.NewRCIEvidenceSource(telemetryClient),
		Policy:             policy,
		DesiredEnabled:     func() bool { return store.Snapshot().Settings.BackgroundTelemetry },
		Lifetime:           lifetime,
		Logger:             logger,
	})

	if capabilityErr != nil {
		logger.Warn("telemetry unavailable", "error", capabilityErr)

		return registration
	}

	registration.capability = capability

	return registration
}

type osThermalReader struct{}

func (osThermalReader) ReadDir(path string) ([]os.DirEntry, error) { return os.ReadDir(path) }
func (osThermalReader) ReadFile(path string) ([]byte, error)       { return os.ReadFile(path) }

const rciHeartbeatTimeout = 5 * time.Second
