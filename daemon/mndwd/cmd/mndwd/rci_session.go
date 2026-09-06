package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/backend"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/establisher"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/sessionmanager"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	"mndwd/internal/rcisession/status"
	rcisessionstore "mndwd/internal/rcisession/store"
	"mndwd/internal/registry"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
)

// rciSessionAssembly owns the persistent-RCI socket bindings and their
// reconciliation with the encrypted credential state.
type rciSessionAssembly struct {
	registry        *registry.Registry
	store           *state.Store
	runtimeRoot     string
	service         *rcisession.Service
	enumerator      *enumeration.Cache
	manager         *sessionmanager.Manager
	establisher     establisher.Establisher
	heartbeat       heartbeat.Probe
	lifetime        context.Context
	cancel          context.CancelFunc
	tickDone        chan struct{}
	poke            chan struct{}
	activeCancel    context.CancelFunc
	establishSem    chan struct{}
	heartbeatEvery  time.Duration
	reconciler      *rcisessionsocket.Reconciler
	logger          *slog.Logger
	activation      atomic.Pointer[activationSnapshot]
	activationPoke  func()
	mu              sync.Mutex
	establishmentWG sync.WaitGroup
}

type activationSnapshot struct {
	grants          map[string]activationGrantFacts
	controllerToken bool
}

type activationGrantFacts struct {
	read  bool
	write bool
}

type persistentSessionRegistration struct {
	close                func()
	err                  error
	permissionController mgmt.PersistentRCIPermissionController
	activationAssembly   *rciSessionAssembly
	capability           *telemetry.Capability
	rciClient            *rci.Client
	eventRCIClient       *rci.Client
	annotationStore      *telemetry.AnnotationStore
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
func assembleRCISession(cfg Config, store *state.Store, reg *registry.Registry, runtimeRoot string, accessMux *http.ServeMux, activationGates *backend.ActivationGateRegistry, logger *slog.Logger, lifetimes ...context.Context) persistentSessionRegistration {
	registration := persistentSessionRegistration{close: func() {}}
	lifetime := context.Background()

	if len(lifetimes) > 0 && lifetimes[0] != nil {
		lifetime = lifetimes[0]
	}

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
	assembly := &rciSessionAssembly{
		registry:       reg,
		store:          store,
		runtimeRoot:    runtimeRoot,
		service:        sessionService,
		enumerator:     enumerator,
		manager:        manager,
		establisher:    establisher.Establisher{AuthURLer: sessionService, HTTPClient: deviceClient, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		heartbeat:      heartbeat.Probe{Timeout: rciHeartbeatTimeout, MaxResponseBytes: cfg.RCIProxyMaxResponseBytes},
		lifetime:       lifetime,
		cancel:         cancel,
		tickDone:       make(chan struct{}),
		poke:           make(chan struct{}, 1),
		establishSem:   make(chan struct{}, rciEstablishWorkers),
		heartbeatEvery: heartbeatInterval(cfg.RCIHeartbeatInterval),
		reconciler:     socketReconciler,
		logger:         logger,
	}
	gate := backend.ActivationGateFunc(func(pluginName, permission string) []backend.ActivationBlocker {
		return assembly.activationEvaluate(pluginName, permission)
	})

	if activationGates != nil {
		activationGates.Register(manifest.PersistentRCISessionReadPermission, gate)
		activationGates.Register(manifest.PersistentRCISessionWritePermission, gate)
	}

	sessionService.SetMutationObserver(func() {
		assembly.reconcileSockets()
		assembly.Poke()
	})
	assembly.reconcileSockets()
	assembly.start()

	registration.close = assembly.close
	registration.permissionController = assembly
	registration.activationAssembly = assembly
	telemetryClient, eventClient, rciErr := newTelemetryAndEventClients(sessionService.Do)

	if rciErr != nil {
		registration.err = rciErr

		return registration
	}

	registration.rciClient = telemetryClient
	registration.eventRCIClient = eventClient

	capability, capabilityErr := telemetry.NewCapability(telemetry.CapabilityConfig{
		RRDToolBinary:      cfg.RRDToolBinary,
		RRDDir:             cfg.RRDDir,
		LoadSampler:        telemetry.NewLoadSampler(telemetryClient),
		TemperatureSampler: telemetry.NewThermalSampler(osThermalReader{}, "/sys/class/thermal"),
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

const (
	rciListDeadline     = 20 * time.Second
	rciHeartbeatTimeout = 5 * time.Second
	rciEstablishTimeout = 15 * time.Second
	rciEstablishWorkers = 4
	rciHeartbeatWorkers = 16
)

func heartbeatInterval(value time.Duration) time.Duration {
	if value <= 0 {
		return defaultRCIHeartbeatInterval
	}

	return value
}

func (a *rciSessionAssembly) start() {
	go a.loop()

	a.Poke()
}

func (a *rciSessionAssembly) loop() {
	defer close(a.tickDone)

	ticker := time.NewTicker(a.heartbeatEvery)

	defer ticker.Stop()

	for {
		select {
		case <-a.lifetime.Done():
			return
		case <-ticker.C:
			a.tick()
		case <-a.poke:
			a.tick()
		}
	}
}

func (a *rciSessionAssembly) Poke() {
	if a == nil || a.enumerator == nil {
		return
	}

	a.mu.Lock()

	if a.activeCancel != nil {
		a.activeCancel()
	}

	select {
	case a.poke <- struct{}{}:
	default:
	}

	a.mu.Unlock()
	a.enumerator.Invalidate()
}

func (a *rciSessionAssembly) tick() {
	tickContext, cancel := context.WithCancel(a.lifetime)

	a.mu.Lock()

	a.activeCancel = cancel

	a.mu.Unlock()
	a.reconcileSessions(tickContext)
	cancel()
	a.mu.Lock()

	a.activeCancel = nil

	a.mu.Unlock()
}

func (a *rciSessionAssembly) reconcileSessions(ctx context.Context) {
	controller := a.service.CaptureController()

	if controller.Token != "" {
		listContext, cancel := context.WithTimeout(ctx, rciListDeadline)
		members, err := a.enumerator.List(listContext)

		cancel()

		if err == nil && ctx.Err() == nil && a.service.ControllerEpoch() == controller.Epoch {
			a.manager.ApplyEnumeration(members)
			a.startEstablishments(ctx, members)
		} else if err != nil {
			var controllerError enumeration.ControllerHTTPError

			if errors.As(err, &controllerError) {
				a.service.InvalidateController(controllerError.Epoch)
			}
		}
	}

	if ctx.Err() != nil {
		return
	}

	targets := a.manager.LiveHeartbeatTargets()

	heartbeat.RunBounded(ctx, targets, rciHeartbeatWorkers, a.heartbeat, func(target heartbeat.Target, result heartbeat.Result) {
		a.manager.CommitHeartbeat(target.Identity, target.Generation, result)

		if result.Unauthorized {
			a.Poke()
		}
	})
}

func (a *rciSessionAssembly) startEstablishments(parent context.Context, members []enumeration.Member) {
	tickEpoch := a.manager.Epoch()

	for _, member := range members {
		if parent.Err() != nil {
			return
		}

		establishContext, epoch, ok := a.manager.BeginEstablishment(member.Identity, tickEpoch)

		if !ok {
			continue
		}

		generation := a.manager.Snapshot().Member(member.Identity).Generation

		a.establishmentWG.Add(1)

		go func(member enumeration.Member, establishContext context.Context, epoch, generation uint64) {
			defer a.establishmentWG.Done()

			select {
			case a.establishSem <- struct{}{}:
			case <-establishContext.Done():
				return
			case <-a.lifetime.Done():
				return
			}

			defer func() { <-a.establishSem }()

			boundedContext, cancel := context.WithTimeout(establishContext, rciEstablishTimeout)
			result, err := a.establisher.Establish(boundedContext, member)

			cancel()

			if err == nil {
				a.manager.CommitEstablishment(member.Identity, epoch, generation, sessionmanager.Candidate{BaseURL: result.BaseURL, Jar: result.Jar, Client: result.Client})

				return
			}

			var establishError establisher.EstablishError

			if errors.As(err, &establishError) && establishError.Kind == "stale" {
				return
			}

			if errors.As(err, &establishError) && establishError.Kind == "unauthorized" {
				a.service.InvalidateController(establishError.Epoch)

				return
			}

			a.manager.FailEstablishment(member.Identity, epoch, establishmentCategory(err), false)
		}(member, establishContext, epoch, generation)
	}
}

func establishmentCategory(err error) status.Category {
	var establishError establisher.EstablishError

	if errors.As(err, &establishError) {
		switch establishError.Kind {
		case "validation":
			return status.Validation
		case "malformed-response":
			return status.MalformedResponse
		case "redemption-failed":
			return status.RedemptionFailed
		case "controller-unavailable":
			return status.ControllerUnavailable
		}
	}

	return status.Transient
}

func (a *rciSessionAssembly) activationEvaluate(pluginName, permission string) []backend.ActivationBlocker {
	if permission != manifest.PersistentRCISessionReadPermission && permission != manifest.PersistentRCISessionWritePermission {
		return nil
	}

	snapshot := a.activation.Load()

	if snapshot == nil {
		return []backend.ActivationBlocker{
			{Permission: permission, Reason: "not-granted"},
			{Permission: permission, Reason: "prerequisite-unavailable", Prerequisite: "controller-token"},
		}
	}

	facts := snapshot.grants[pluginName]
	grant := facts.read || facts.write

	if permission == manifest.PersistentRCISessionWritePermission {
		grant = facts.write
	}

	blockers := make([]backend.ActivationBlocker, 0, 2)

	if !grant {
		blockers = append(blockers, backend.ActivationBlocker{Permission: permission, Reason: "not-granted"})
	}

	if !snapshot.controllerToken {
		blockers = append(blockers, backend.ActivationBlocker{
			Permission:   permission,
			Reason:       "prerequisite-unavailable",
			Prerequisite: "controller-token",
		})
	}

	return blockers
}

func (a *rciSessionAssembly) SetActivationPoke(poke func()) {
	a.mu.Lock()

	a.activationPoke = poke

	a.mu.Unlock()
}

func (a *rciSessionAssembly) reconcileSockets() {
	a.mu.Lock()

	report, changed, err := a.reconcileSocketsLocked()
	poke := a.activationPoke

	a.mu.Unlock()

	if err != nil {
		a.serviceLogger().Error("persistent RCI socket reconciliation failed", "reason", "reconcile", "error", err)
	}

	for plugin := range report.StartErrors {
		a.serviceLogger().Error("persistent RCI socket start failed", "plugin", plugin, "reason", "reconcile")
	}

	if changed && poke != nil {
		poke()
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

	report, changed, err := a.reconcileSocketsLocked()
	poke := a.activationPoke
	available := report.Desired[plugin] && !report.Active[plugin]

	a.mu.Unlock()

	if changed && poke != nil {
		poke()
	}

	if err != nil {
		return err
	}

	if available {
		return fmt.Errorf("%w: plugin %s socket unavailable", mgmt.ErrPersistentRCISocketStart, plugin)
	}

	return nil
}

func (a *rciSessionAssembly) close() {
	if a.cancel != nil {
		a.cancel()
	}

	if a.manager != nil {
		a.manager.DiscardAll()
	}

	if a.tickDone != nil {
		<-a.tickDone
	}

	a.establishmentWG.Wait()
	a.mu.Lock()

	if a.reconciler != nil {
		a.reconciler.Close()
	}

	a.mu.Unlock()
}

func (a *rciSessionAssembly) reconcileSocketsLocked() (rcisessionsocket.ReconcileReport, bool, error) {
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
	present := controllerTokenPresent(document)

	report, err := a.reconciler.Reconcile(context.Background(), bindings, present)
	changed := a.publishActivationSnapshotLocked(present)

	return report, changed, err
}

func controllerTokenPresent(document model.Document) bool {
	return document.Controller != nil && document.Controller.Token != ""
}

func (a *rciSessionAssembly) publishActivationSnapshotLocked(present bool) bool {
	next := make(map[string]activationGrantFacts)

	for _, plugin := range a.registry.AllBackendPlugins() {
		read := a.store.HasGrant(plugin.Name, manifest.PersistentRCISessionReadPermission)
		write := a.store.HasGrant(plugin.Name, manifest.PersistentRCISessionWritePermission)
		next[plugin.Name] = activationGrantFacts{read: read, write: write}
	}

	previous := a.activation.Load()
	changed := previous == nil || previous.controllerToken != present || !sameActivationSnapshot(previous.grants, next)

	a.activation.Store(&activationSnapshot{grants: next, controllerToken: present})

	return changed
}

func sameActivationSnapshot(previous, next map[string]activationGrantFacts) bool {
	if len(previous) != len(next) {
		return false
	}

	for pluginName, facts := range previous {
		nextFacts, ok := next[pluginName]

		if !ok || nextFacts != facts {
			return false
		}
	}

	return true
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
