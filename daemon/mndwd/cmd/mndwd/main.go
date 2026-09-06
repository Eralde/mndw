// Command mndwd is the mndw device daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"
	_ "time/tzdata"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/authz"
	"mndwd/internal/backend"
	"mndwd/internal/deviceinfo"
	"mndwd/internal/deviceproxy"
	"mndwd/internal/diagnostics"
	"mndwd/internal/events"
	"mndwd/internal/frontend"
	"mndwd/internal/httpx"
	"mndwd/internal/listen"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/palette"
	"mndwd/internal/registry"
	"mndwd/internal/selfupdate"
	"mndwd/internal/service"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
)

// version is stamped at build time via -ldflags "-X main.version=<v>" and
// single-sourced from the root package.json.
var version = "dev"

const telemetryShutdownTimeout = 30 * time.Second

func main() {
	cfg, showVersion, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if showVersion {
		fmt.Println("mndwd", version)

		return
	}

	if err := run(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "mndwd:", err)
		os.Exit(1)
	}
}

func run(cfg Config) error {
	level, _ := parseLevel(cfg.LogLevel)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	if cfg.Dev {
		logger.Warn("running in --dev mode: ALL session auth is bypassed — never use on a real device")
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		return fmt.Errorf("open state: %w", err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		return fmt.Errorf("open palette store: %w", err)
	}

	verifier := authz.New(cfg.DeviceURL, cfg.Dev, logger, authz.Options{})
	// The lifetime context is created before management wiring so service actions can
	// survive request cancellation but still stop when the daemon shuts down.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	c := assemble(cfg, store, paletteStore, verifier, logger, ctx)

	if c.startupErr != nil {
		c.closeTelemetry()
		c.closePersistentSession()

		_ = c.runtime.Shutdown(context.Background())

		return c.startupErr
	}

	var listener net.Listener

	if cfg.FrontDoorMode() {
		selected, port, selectErr := listen.Select(listen.Config{
			BindAddr:      cfg.FrontendListen,
			PersistPath:   filepath.Join(cfg.DataDir, "frontend-port"),
			SeedPath:      filepath.Join(cfg.DataDir, "lighttpd-port"),
			DefaultPort:   listen.DefaultPort,
			FallbackPorts: listen.DefaultFallbackPorts,
			RetryAttempts: 5,
			RetryDelay:    300 * time.Millisecond,
		})

		if selectErr != nil {
			c.closeTelemetry()
			c.closePersistentSession()

			_ = c.runtime.Shutdown(context.Background())

			return selectErr
		}

		listener = selected

		logger.Info("mndwd front door", "url", fmt.Sprintf("http://<device-ip>:%d/", port), "port", port)
	}

	if c.activationAssembly != nil {
		// Supervisor.Start only launches the child and probes its local backend
		// readiness socket; it makes no controller-RCI call. The synchronous poke
		// therefore cannot re-enter this mutation observer while holding its mutex.
		c.activationAssembly.SetActivationPoke(func() {
			c.runtime.Reconcile(ctx, c.reg.AllBackendPlugins())
		})
	}

	// Dependency installation is an explicit management operation. Startup only
	// reconciles already-approved service manifests; it never runs opkg retries or
	// executes plugin commands before the listener is available.
	c.runtime.Reconcile(ctx, c.reg.AllBackendPlugins())

	if c.startEvents != nil {
		if err := c.startEvents(ctx); err != nil {
			c.closeEvents()
			c.closeTelemetry()
			c.closePersistentSession()

			_ = c.runtime.Shutdown(context.Background())

			return err
		}
	}

	if c.telemetry != nil {
		go func() {
			if err := c.telemetry.StartWithRetry(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Error("telemetry startup stopped", "error", err)
			}
		}()
	}

	srv := &http.Server{
		Handler:           c.handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	if listener != nil {
		srv.Addr = listener.Addr().String()
	} else {
		srv.Addr = cfg.Listen
	}

	var closePersistentOnce sync.Once
	closePersistent := func() {
		closePersistentOnce.Do(c.closePersistentSession)
	}
	err = serveWithDrain(ctx, srv, listener, logger, func() {
		c.stopEvents("shutdown")
	}, cfg.HTTPDrainTimeout)

	c.closeEvents()
	c.closeTelemetry()
	closePersistent()

	if shutdownErr := c.runtime.Shutdown(context.Background()); shutdownErr != nil {
		logger.Error("backend shutdown failed", "error", shutdownErr)

		if err == nil {
			err = shutdownErr
		}
	}

	return err
}

// components is the fully-wired daemon and the persistent RCI session cleanup.
type components struct {
	handler                http.Handler
	reg                    *registry.Registry
	runtime                *backend.RuntimeImpl
	gateway                *backend.Gateway
	activationAssembly     *rciSessionAssembly
	closePersistentSession func()
	closeTelemetry         func()
	telemetry              *telemetry.Capability
	startEvents            func(context.Context) error
	stopEvents             func(string)
	closeEvents            func()
	startupErr             error
}

// assemble builds the fully-wired daemon. Kept separate from run so the integration
// test can drive the exact same wiring over httptest.
func assemble(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger, lifetime context.Context) components {
	eventBus := events.NewBus()
	normalizer := events.NewNormalizer(time.Now, nil)
	internalPublisher := events.NewInternalPublisher(eventBus, normalizer)
	ingestPublisher := events.NewDeduplicatingPublisher(eventBus, events.NewDeduplicator(time.Now))
	reg := registry.NewWithLogger(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir, logger)
	stateDir := cfg.SelfUpdateStateDir

	if stateDir == "" {
		stateDir = defaultSelfUpdateStateDir
	}

	helperPath := cfg.SelfUpdateHelper

	if helperPath == "" {
		helperPath = defaultSelfUpdateHelper
	}

	opkgMgr := opkg.NewWithPaths(cfg.Opkg, logger, opkg.Paths{
		StateDir:   stateDir,
		PendingDir: filepath.Join(stateDir, "pending"),
		LockPath:   filepath.Join(stateDir, "self-update.lock"),
	})
	selfUpdateService := selfupdate.New(selfupdate.Config{
		StateDir:       stateDir,
		PackagedHelper: helperPath,
		RunningVersion: version,
		Logger:         logger,
	}, opkgMgr)
	serviceMgr := service.New(cfg.Service, logger)
	activationGates := backend.NewActivationGateRegistry()
	runtimeRoot := cfg.PluginRuntimeRoot

	if runtimeRoot == "" {
		runtimeRoot = defaultPluginRuntimeRoot
	}

	runtime := backend.NewRuntime(backend.RuntimeConfig{
		RuntimeRoot:     runtimeRoot,
		PluginDataRoot:  filepath.Join(cfg.DataDir, "plugin-data"),
		ActivationGates: activationGates,
		Limits: backend.Limits{
			MaxConcurrentExecTotal:     cfg.MaxConcurrentExecTotal,
			MaxConcurrentExecPerPlugin: cfg.MaxConcurrentExecPerPlugin,
			MaxSupervisedServices:      cfg.MaxSupervisedServices,
		},
		SupportedServiceProtocols: cfg.SupportedServiceProtocols,
		Exec: backend.ExecRunnerConfig{
			Timeout:      cfg.ExecTimeout,
			KillGrace:    cfg.ExecKillGrace,
			MaxBodyBytes: cfg.MaxRequestBytes,
			Logger:       logger,
			Dev:          cfg.Dev,
		},
		Supervisor: backend.SupervisorConfig{
			ReadinessTimeout:          cfg.ServiceHTTPTimeout,
			StopTimeout:               cfg.ServiceStopTimeout,
			FinalReapTimeout:          cfg.FinalReapTimeout,
			AllowSymlinkedBuiltinRoot: cfg.Dev,
			Logger:                    logger,
			LifetimeCtx:               lifetime,
		},
	})

	runtime.SetLifecycleObserver(func(event backend.LifecycleEvent) {
		if event.State == "started" {
			_ = internalPublisher.Publish(contractEvents.TopicPluginStarted, map[string]any{"name": event.Plugin})

			return
		}

		_ = internalPublisher.Publish(contractEvents.TopicPluginStopped, map[string]any{
			"name":   event.Plugin,
			"reason": event.Reason,
		})
	})

	mux := http.NewServeMux()

	mux.Handle("POST /_internal/hook", events.NewHookHandler(ingestPublisher, normalizer))
	mux.Handle("GET /ws/events", verifier.Middleware(events.NewWebSocketHandler(eventBus, backend.ValidWebSocketOrigin)))

	accessRegistration := registerAccess(mux, cfg, store, reg, runtimeRoot, runtime, activationGates, verifier, logger, lifetime)
	mgmtMux := registerMgmt(mux, cfg, store, opkgMgr, selfUpdateService, serviceMgr, reg, runtime, accessRegistration.permissionController, accessRegistration.capability, verifier, logger, lifetime, internalPublisher)
	deviceFetcher, deviceInfoErr := deviceinfo.NewHTTPFetcher(cfg.DeviceURL, logger, deviceinfo.FetcherOptions{})

	if deviceInfoErr == nil {
		deviceinfo.NewHandler(deviceinfo.NewStore(deviceFetcher, deviceinfo.StoreOptions{}), logger).RegisterProtected(mgmtMux)
	}

	registerPalette(mux, mgmtMux, paletteStore, logger)

	gateway := registerPlugins(mux, cfg, reg, activationGates, verifier, runtime, logger)
	frontDoorErr := registerFrontDoor(mux, cfg, logger)

	gateway.SetTrafficBlockPredicate(runtime.BlocksTraffic)
	runtime.SetLifecycleHooks(gateway.ClosePluginSockets)
	runtime.SetPlatformMaintenanceHook(gateway.BeginPlatformMaintenance)

	var routed http.Handler = mux

	if cfg.FrontDoorMode() {
		routed = frontend.TraversalGuard(mux)
	}

	startupErr := accessRegistration.err

	if startupErr == nil {
		startupErr = frontDoorErr
	}

	if startupErr == nil {
		startupErr = deviceInfoErr
	}

	var eventCancel context.CancelFunc
	var eventDone bool
	daemonStartedAt := time.Now()
	startEvents := func(ctx context.Context) error {
		if eventDone {
			return nil
		}

		eventCtx, cancel := context.WithCancel(ctx)
		eventCancel = cancel

		if _, err := selfUpdateService.Status(); err != nil {
			logger.Warn("self-update startup status unavailable", "error", err)
		}

		selfUpdateStateDir := cfg.SelfUpdateStateDir

		if selfUpdateStateDir == "" {
			selfUpdateStateDir = defaultSelfUpdateStateDir
		}

		completion, completionErr := selfupdate.NewStateStore(selfUpdateStateDir).ConsumeCompletion()

		if completionErr == nil {
			_ = internalPublisher.Publish(contractEvents.TopicDaemonUpdated, map[string]any{"version": completion.TargetVersion})
		} else if !errors.Is(completionErr, selfupdate.ErrNoIntent) {
			logger.Warn("self-update completion record unavailable", "error", completionErr)
		}

		if accessRegistration.annotationStore != nil {
			if err := accessRegistration.annotationStore.Start(eventCtx, eventBus); err != nil {
				cancel()

				return fmt.Errorf("start event annotations: %w", err)
			}
		}

		if accessRegistration.eventRCIClient == nil {
			logger.Warn("event log poller disabled: no RCI client available")
		} else {
			deviceTZ := events.QueryDeviceTimezone(eventCtx, accessRegistration.eventRCIClient)
			parser := events.NewLogParser(normalizer, deviceTZ, nil, logger)
			pollTicker := time.NewTicker(events.LogPollInterval)
			poller := events.NewLogPoller(events.LogPollerConfig{
				Source:     events.NewRCILogSource(accessRegistration.eventRCIClient),
				Parser:     parser,
				Publisher:  ingestPublisher,
				Ticker:     pollTicker.C,
				StopTicker: pollTicker.Stop,
				Logger:     logger,
			})

			go poller.Run(eventCtx)
		}

		storage := events.NewStorageMonitor("/opt", nil, internalPublisher, logger)

		go storage.Run(eventCtx)

		publishActivePluginEvents(reg, store, internalPublisher, logger)

		_ = internalPublisher.Publish(contractEvents.TopicDaemonStarted, map[string]any{
			"version":   version,
			"uptime_ms": time.Since(daemonStartedAt).Milliseconds(),
		})
		eventDone = true

		return nil
	}
	stopEvents := func(reason string) {
		if !eventDone {
			return
		}

		_ = internalPublisher.Publish(contractEvents.TopicDaemonStopping, map[string]any{"reason": reason})

		if eventCancel != nil {
			eventCancel()
		}
	}
	closeEvents := func() {
		if eventCancel != nil {
			eventCancel()

			eventCancel = nil
		}

		if accessRegistration.annotationStore != nil {
			closeCtx, cancel := context.WithTimeout(context.Background(), telemetryShutdownTimeout)

			if err := accessRegistration.annotationStore.Close(closeCtx); err != nil {
				logger.Warn("telemetry annotations shutdown failed", "error", err)
			}

			cancel()
		}
	}

	return components{
		handler:                httpx.NoCORSHandler(httpx.LogMiddleware(logger, routed)),
		reg:                    reg,
		runtime:                runtime,
		gateway:                gateway,
		activationAssembly:     accessRegistration.activationAssembly,
		closePersistentSession: accessRegistration.close,
		closeTelemetry: func() {
			if accessRegistration.capability != nil {
				closeCtx, cancel := context.WithTimeout(context.Background(), telemetryShutdownTimeout)

				defer cancel()

				if closeErr := accessRegistration.capability.Close(closeCtx); closeErr != nil {
					logger.Error("telemetry shutdown failed", "error", closeErr)
				}
			}
		},
		telemetry:   accessRegistration.capability,
		startEvents: startEvents,
		stopEvents:  stopEvents,
		closeEvents: closeEvents,
		startupErr:  startupErr,
	}
}

func publishActivePluginEvents(reg *registry.Registry, store *state.Store, publisher *events.InternalPublisher, logger *slog.Logger) {
	if reg == nil || store == nil || publisher == nil {
		return
	}

	snapshot := store.Snapshot()
	names := make([]string, 0, len(snapshot.Plugins))

	for name, plugin := range snapshot.Plugins {
		if plugin != nil && plugin.Approval == state.ApprovalApproved && plugin.Enabled && !plugin.RemovalPending {
			names = append(names, name)
		}
	}

	sort.Strings(names)

	for _, name := range names {
		plugin, ok := reg.Resolve(name)

		if !ok || plugin.Manifest == nil {
			continue
		}

		if err := publisher.Publish(contractEvents.TopicPluginInstalled, map[string]any{"name": name, "version": derefVersion(plugin.Manifest.Version)}); err != nil {
			logger.Warn("plugin.installed publish failed", "plugin", name, "error", err)
		}
	}

	builtins, err := reg.ListBuiltinsWithError()
	if err != nil {
		logger.Warn("builtin plugin discovery failed", "error", err)

		return
	}

	for _, plugin := range builtins {
		if _, reserved := snapshot.Plugins[plugin.Name]; reserved || plugin.Manifest == nil {
			continue
		}

		if err := publisher.Publish(contractEvents.TopicPluginInstalled, map[string]any{"name": plugin.Name, "version": derefVersion(plugin.Manifest.Version)}); err != nil {
			logger.Warn("plugin.installed publish failed", "plugin", plugin.Name, "error", err)
		}
	}
}

func derefVersion(value *string) string {
	if value == nil {
		return "unknown"
	}

	return *value
}

func registerFrontDoor(mux *http.ServeMux, cfg Config, logger *slog.Logger) error {
	if !cfg.FrontDoorMode() {
		return nil
	}

	proxy, err := deviceproxy.New(cfg.DeviceURL, logger)
	if err != nil {
		return fmt.Errorf("device proxy: %w", err)
	}

	for _, prefix := range []string{"/rci", "/ci", "/auth"} {
		mux.Handle(prefix, proxy)
		mux.Handle(prefix+"/", proxy)
	}

	apiReserved := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.NotFound(writer, request)
	})

	for _, prefix := range []string{"/api", "/ws"} {
		mux.Handle(prefix, apiReserved)
		mux.Handle(prefix+"/", apiReserved)
	}

	handler, err := frontend.New(cfg.FrontendDir, cfg.UserPluginsDir)
	if err != nil {
		return fmt.Errorf("frontend handler: %w", err)
	}

	handler.Register(mux)

	return nil
}

// registerMgmt mounts the session-gated management surface and returns its mux so
// other session-gated routes (e.g. protected palette) can share the gate.
func registerMgmt(mux *http.ServeMux, cfg Config, store *state.Store, opkgMgr opkg.Manager, selfUpdateService selfupdate.Service, serviceMgr service.Manager, reg *registry.Registry, runtime *backend.RuntimeImpl, permissionController mgmt.PersistentRCIPermissionController, telemetryController mgmt.TelemetryController, verifier *authz.Verifier, logger *slog.Logger, lifetime context.Context, eventPublisher *events.InternalPublisher) *http.ServeMux {
	mgmtHandler := mgmt.New(mgmt.Config{
		StagingDir:                        cfg.StagingDir(),
		UserPluginsDir:                    cfg.UserPluginsDir,
		BuiltinPluginsDir:                 cfg.BuiltinPluginsDir,
		MaxUploadBytes:                    maxUploadBytes,
		Runtime:                           runtime,
		PersistentRCIPermissionController: permissionController,
		ServiceActionRoot:                 lifetime,
		SelfUpdate:                        selfUpdateService,
		TelemetryController:               telemetryController,
		PublishEvent: func(topic string, payload map[string]any) error {
			return eventPublisher.PublishNamed(topic, payload)
		},
	}, store, opkgMgr, serviceMgr, reg, logger)

	mgmtMux := http.NewServeMux()

	mgmtHandler.Register(mgmtMux)
	mux.Handle("/api/mgmt/", verifier.Middleware(mgmtMux))

	return mgmtMux
}

// registerAccess mounts the consent/diagnostics surface plus the persistent RCI
// session, returning the session's cleanup func.
func registerAccess(mux *http.ServeMux, cfg Config, store *state.Store, reg *registry.Registry, runtimeRoot string, runtime *backend.RuntimeImpl, activationGates *backend.ActivationGateRegistry, verifier *authz.Verifier, logger *slog.Logger, lifetimes ...context.Context) persistentSessionRegistration {
	accessMux := http.NewServeMux()
	diagnosticsLogFile := cfg.DiagnosticsLogFile

	if diagnosticsLogFile == "" {
		diagnosticsLogFile = defaultDiagnosticsLogFile
	}

	diagnostics.New(diagnostics.Config{
		LogFile: diagnosticsLogFile,
		Plugins: diagnosticsPlugins(reg, runtime),
	}).Register(accessMux)

	registration := assembleRCISession(cfg, store, reg, runtimeRoot, accessMux, activationGates, logger, lifetimes...)

	if registration.capability != nil {
		cache := telemetry.NewSnapshotCache(
			registration.capability.LoadReader(),
			registration.capability.TemperatureReader(),
			time.Now,
		)

		telemetryHandler := telemetry.NewHandler(cache, registration.capability.IsEnabled, logger)
		annotationDir := cfg.RRDDir

		if annotationDir == "" {
			annotationDir = defaultRRDDir
		}

		annotationStore, annotationErr := telemetry.NewAnnotationStore(telemetry.AnnotationStoreConfig{
			RRDDir:  annotationDir,
			Catalog: telemetry.DefaultAnnotationCatalog{},
			Logger:  logger,
		})

		if annotationErr != nil {
			logger.Warn("telemetry annotation store unavailable", "error", annotationErr)
		} else {
			registration.annotationStore = annotationStore

			telemetryHandler.SetAnnotationStore(annotationStore)
		}

		telemetryHandler.Register(accessMux)
	}

	// Keep the route mounted in dev so the host exercises the same consent contract;
	// the verifier still bypasses only session validation when cfg.Dev is true.
	mux.Handle("/api/mndw/", verifier.Middleware(accessMux))

	return registration
}

// registerPalette mounts the public palette route and its session-gated counterpart.
func registerPalette(mux *http.ServeMux, mgmtMux *http.ServeMux, paletteStore *palette.Store, logger *slog.Logger) {
	paletteHandler := palette.NewHandler(paletteStore, logger)

	paletteHandler.RegisterPublic(mux)
	paletteHandler.RegisterProtected(mgmtMux)
}

// registerPlugins mounts the single manifest backend gateway.
func registerPlugins(mux *http.ServeMux, cfg Config, reg *registry.Registry, activationGates *backend.ActivationGateRegistry, verifier *authz.Verifier, runtime *backend.RuntimeImpl, logger *slog.Logger) *backend.Gateway {
	gateway := backend.NewGateway(backend.GatewayConfig{
		MaxRequestBytes:           cfg.MaxRequestBytes,
		ServiceHTTPTimeout:        cfg.ServiceHTTPTimeout,
		AllowSymlinkedBuiltinRoot: cfg.Dev,
		ActivationGates:           activationGates,
	}, reg, verifier, runtime.ExecRunner(), runtime.Supervisor(), logger)

	gateway.Register(mux)

	return gateway
}

func diagnosticsPlugins(reg *registry.Registry, runtime *backend.RuntimeImpl) []diagnostics.Plugin {
	plugins := make([]diagnostics.Plugin, 0)

	for _, plugin := range reg.AllBackendPlugins() {
		if plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil || *plugin.Manifest.Backend.Kind != manifest.BackendKindService {
			continue
		}

		pluginID := plugin.Name
		entry := diagnostics.Plugin{ID: pluginID}

		if runtime != nil {
			entry.Supervisor = func() diagnostics.SupervisorDiagnostics {
				status := runtime.Status(pluginID)

				return diagnostics.SupervisorDiagnostics{
					State:               string(status.State),
					RestartCount:        status.RestartCount,
					ConsecutiveFailures: status.ConsecutiveFailures,
					LastExit:            status.LastExit,
					LastError:           status.LastError,
					RecentStderr:        status.RecentStderr,
				}
			}
			entry.Live = func(ctx context.Context) ([]byte, error) {
				return runtime.LiveDiagnostics(ctx, pluginID)
			}
		}

		plugins = append(plugins, entry)
	}

	sort.Slice(plugins, func(left, right int) bool { return plugins[left].ID < plugins[right].ID })

	return plugins
}

// serve runs the HTTP server until ctx is canceled or the listener fails, then
// shuts down gracefully.
func serve(ctx context.Context, srv *http.Server, logger *slog.Logger, onShutdown func()) error {
	return serveWithDrain(ctx, srv, nil, logger, onShutdown, 10*time.Second)
}

func serveWithDrain(ctx context.Context, srv *http.Server, listener net.Listener, logger *slog.Logger, onShutdown func(), drainTimeout time.Duration) error {
	if drainTimeout <= 0 {
		drainTimeout = 35 * time.Second
	}

	errCh := make(chan error, 1)

	go func() {
		logger.Info("mndwd listening", "addr", srv.Addr, "version", version)

		var serveErr error

		if listener != nil {
			serveErr = srv.Serve(listener)
		} else {
			serveErr = srv.ListenAndServe()
		}

		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr

			return
		}

		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining")

		if onShutdown != nil {
			onShutdown()
		}

		shutdownCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)

		defer cancel()

		return srv.Shutdown(shutdownCtx)
	}
}
