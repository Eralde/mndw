// Command mndwd is the mndw device daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"

	contractEvents "mndw.local/contracts/events"
	rci "mndw.local/rci"
	"mndwd/internal/authz"
	"mndwd/internal/backend"
	"mndwd/internal/deviceinfo"
	"mndwd/internal/deviceproxy"
	"mndwd/internal/diagnostics"
	"mndwd/internal/events"
	"mndwd/internal/frontend"
	"mndwd/internal/httpx"
	"mndwd/internal/initd"
	"mndwd/internal/listen"
	daemonlogging "mndwd/internal/logging"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/palette"
	"mndwd/internal/registry"
	"mndwd/internal/selfupdate"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
)

// version is stamped at build time via -ldflags "-X main.version=<v>" and
// single-sourced from the root package.json.
var version = "dev"

const telemetryShutdownTimeout = 30 * time.Second

var deviceProxyPrefixes = []string{"/rci", "/ci", "/auth"}

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

func run(cfg Config) (err error) {
	level, _ := parseLevel(cfg.LogLevel)
	var fileLog *daemonlogging.RotatingFile
	var writer io.Writer = os.Stdout

	if cfg.LogFile != "" {
		openedLog, logErr := daemonlogging.OpenRotatingFile(cfg.LogFile, daemonlogging.DefaultLogFileLimit)
		fileLog = openedLog
		writer = fileLog

		if logErr != nil {
			fmt.Fprintln(os.Stderr, "mndwd: log file unavailable; writes will resume when it is writable")
		}
	}

	baseHandler := slog.NewTextHandler(writer, &slog.HandlerOptions{Level: level})
	repeatHandler := daemonlogging.NewRepeatHandler(baseHandler, daemonlogging.RepeatHandlerConfig{})

	logger := slog.New(repeatHandler)

	defer func() {
		if closeErr := repeatHandler.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("flush logs: %w", closeErr))
		}

		if fileLog != nil {
			if closeErr := fileLog.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close log file: %w", closeErr))
			}
		}
	}()

	if cfg.Dev {
		logger.Warn("running in --dev mode: ALL session auth is bypassed — never use on a real device")
	}

	store, err := state.Open(cfg.StateFile(), logger)
	if err != nil {
		return fmt.Errorf("open state: %w", err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile(), logger)
	if err != nil {
		return fmt.Errorf("open palette store: %w", err)
	}

	verifier := authz.New(cfg.DeviceURL, cfg.Dev, logger, authz.Options{})
	// The lifetime context is created before management wiring so service actions can
	// survive request cancellation but still stop when the daemon shuts down.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)

	defer stop()

	c, err := assemble(cfg, store, paletteStore, verifier, logger, ctx)
	if err != nil {
		return err
	}

	defer func() {
		if closeErr := c.Close(); closeErr != nil {
			logger.Error("shutdown failed", "error", closeErr)

			if err == nil {
				err = closeErr
			}
		}
	}()

	var listener net.Listener

	if cfg.FrontDoorMode() {
		selection, selectErr := listen.Select(listen.Config{
			BindAddr:      cfg.FrontendListen,
			PersistPath:   filepath.Join(cfg.DataDir, "frontend-port"),
			SeedPath:      filepath.Join(cfg.DataDir, "lighttpd-port"),
			DefaultPort:   listen.DefaultPort,
			FallbackPorts: listen.DefaultFallbackPorts,
			RetryAttempts: 5,
			RetryDelay:    300 * time.Millisecond,
		})

		if selectErr != nil {
			return selectErr
		}

		listener = selection.Listener

		if selection.UsedFallback {
			logger.Warn("front door port busy, using fallback", "preferred", selection.PreferredPort, "port", selection.Port)
		}

		logger.Info("mndwd front door", "url", fmt.Sprintf("http://<device-ip>:%d/", selection.Port), "port", selection.Port)
	}

	// Dependency installation is an explicit management operation. Startup only
	// reconciles already-approved service manifests; it never runs opkg retries or
	// executes plugin commands before the listener is available.
	c.runtime.Reconcile(ctx, c.reg.AllBackendPlugins())

	if err := c.events.Start(ctx); err != nil {
		return err
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
		IdleTimeout:       defaultHTTPIdleTimeout,
	}

	if listener != nil {
		srv.Addr = listener.Addr().String()
	} else {
		srv.Addr = cfg.Listen
	}

	return serveWithDrain(ctx, srv, listener, logger, func() {
		c.events.Stop("shutdown")
	}, defaultHTTPDrainTimeout)
}

// components is the fully-wired daemon. Close releases everything assemble
// started, newest first.
type components struct {
	handler   http.Handler
	reg       *registry.Registry
	runtime   *backend.Runtime
	gateway   *backend.Gateway
	telemetry *telemetry.Capability
	events    *eventLifecycle
	cleanup   cleanupStack
}

// Close stops events, telemetry, the persistent RCI session, and the backend
// runtime, in that order. Only the runtime's shutdown error is returned; the
// others are logged by their closers.
func (c *components) Close() error {
	return c.cleanup.closeAll()
}

// closeTelemetry stops the telemetry pipeline. Failures are logged, not
// returned, so a stuck flush never changes the daemon's exit status.
func closeTelemetry(capability *telemetry.Capability, logger *slog.Logger) {
	if capability == nil {
		return
	}

	closeCtx, cancel := context.WithTimeout(context.Background(), telemetryShutdownTimeout)

	defer cancel()

	if err := capability.Close(closeCtx); err != nil {
		logger.Error("telemetry shutdown failed", "error", err)
	}
}

// daemonCore is the set of long-lived collaborators every route group shares.
type daemonCore struct {
	cfg             Config
	store           *state.Store
	reg             *registry.Registry
	runtime         *backend.Runtime
	activationGates *backend.ActivationGateRegistry
	verifier        *authz.Verifier
	logger          *slog.Logger
	lifetime        context.Context
}

// mgmtServices are the management-only collaborators registerMgmt needs on top
// of daemonCore.
type mgmtServices struct {
	opkg                 opkg.Manager
	selfUpdate           *selfupdate.Service
	service              initd.Manager
	capabilityController mgmt.PersistentRCICapabilityController
	telemetryController  mgmt.TelemetryController
	events               *events.InternalPublisher
}

type accessAssembly struct {
	session   rciSessionAssembly
	telemetry telemetryAssembly
}

// assemble builds the fully-wired daemon. When startup fails it unwinds
// everything already built (newest first) before returning the error, so the
// caller never owns a half-started daemon. Kept separate from run so the
// integration tests drive the exact same wiring over httptest.
func assemble(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger, lifetime context.Context) (*components, error) {
	c, err := buildComponents(cfg, store, paletteStore, verifier, logger, lifetime)
	if err != nil {
		if closeErr := c.Close(); closeErr != nil {
			logger.Error("cleanup after failed startup", "error", closeErr)
		}

		return nil, err
	}

	return c, nil
}

// buildComponents constructs every subsystem and mounts the route tree. It
// always returns non-nil components holding every closer registered so far,
// even with a startup error, so the caller decides whether to unwind them.
func buildComponents(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger, lifetime context.Context) (*components, error) {
	cfg = cfg.withDefaults()

	eventBus := events.NewBus()
	normalizer := events.NewNormalizer(time.Now, nil)
	internalPublisher := events.NewInternalPublisher(eventBus, normalizer)
	ingestPublisher := events.NewDeduplicatingPublisher(eventBus, events.NewDeduplicator(time.Now))
	reg := registry.NewWithLogger(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir, logger)
	opkgPaths := opkg.Paths{
		StateDir:   cfg.SelfUpdateStateDir,
		PendingDir: filepath.Join(cfg.SelfUpdateStateDir, "pending"),
		LockPath:   filepath.Join(cfg.SelfUpdateStateDir, "self-update.lock"),
	}
	var opkgMgr opkg.SelfUpdateManager

	if cfg.Opkg == "stub" {
		opkgMgr = opkg.NewStub(logger)
	} else {
		opkgMgr = opkg.NewExecWithPaths(logger, opkgPaths)
	}

	selfUpdateService := selfupdate.New(selfupdate.Config{
		StateDir:       cfg.SelfUpdateStateDir,
		PackagedHelper: cfg.SelfUpdateHelper,
		RunningVersion: version,
		Logger:         logger,
	}, opkgMgr)
	serviceMgr := initd.New(cfg.Service, logger)
	activationGates := backend.NewActivationGateRegistry()
	runtime := backend.NewRuntime(backend.RuntimeConfig{
		RuntimeRoot:     cfg.PluginRuntimeRoot,
		PluginDataRoot:  filepath.Join(cfg.DataDir, "plugin-data"),
		ActivationGates: activationGates,
		Limits: backend.Limits{
			MaxConcurrentExecTotal:     cfg.MaxConcurrentExecTotal,
			MaxConcurrentExecPerPlugin: cfg.MaxConcurrentExecPerPlugin,
			MaxSupervisedServices:      cfg.MaxSupervisedServices,
		},
		Exec: backendExecConfig(cfg, logger),
		Supervisor: backend.SupervisorConfig{
			ReadinessTimeout:          cfg.ServiceHTTPTimeout,
			StopTimeout:               cfg.ServiceStopTimeout,
			FinalReapTimeout:          cfg.FinalReapTimeout,
			AllowSymlinkedBuiltinRoot: cfg.Dev,
			Logger:                    logger,
			LifetimeCtx:               lifetime,
		},
		OnLifecycle: func(event backend.LifecycleEvent) {
			if event.State == backend.LifecycleStarted {
				_ = internalPublisher.PublishPluginStarted(contractEvents.PluginStartedPayload{Name: event.Plugin})

				return
			}

			_ = internalPublisher.PublishPluginStopped(contractEvents.PluginStoppedPayload{
				Name:   event.Plugin,
				Reason: string(event.Reason),
			})
		},
	})

	var cleanup cleanupStack

	cleanup.push("backend runtime", func() error {
		return runtime.Shutdown(context.Background())
	})

	mux := http.NewServeMux()
	intake := httpx.NewBodyIntake(httpx.DefaultBodyIntakeLimit)
	core := daemonCore{
		cfg:             cfg,
		store:           store,
		reg:             reg,
		runtime:         runtime,
		activationGates: activationGates,
		verifier:        verifier,
		logger:          logger,
		lifetime:        lifetime,
	}

	hookLimit := func(*http.Request) httpx.BodyLimit {
		return httpx.BodyLimit{MaxBytes: events.MaxEventPayloadBytes * 4, Timeout: httpx.JSONBodyTimeout, TooLargeCode: httpx.CodeBodyTooLarge}
	}

	mux.Handle("POST /_internal/hook", intake.Middleware(hookLimit, events.NewHookHandler(ingestPublisher, normalizer)))
	mux.Handle("GET /ws/events", verifier.Middleware(rejectWebSocketBody(events.NewWebSocketHandler(eventBus, backend.ValidWebSocketOrigin))))

	access := registerAccess(mux, core, intake)
	var eventRCIClient *rci.Client
	var eventClientErr error

	if access.session.service != nil {
		eventRCIClient, eventClientErr = newControllerRCIClient(access.session.service.Do)
	}

	cleanup.push("persistent RCI session", func() error {
		access.session.close()

		return nil
	})
	cleanup.push("telemetry", func() error {
		closeTelemetry(access.telemetry.capability, logger)

		return nil
	})

	mgmtMux := registerMgmt(mux, core, intake, mgmtServices{
		opkg:                 opkgMgr,
		selfUpdate:           selfUpdateService,
		service:              serviceMgr,
		capabilityController: access.session.capabilityController,
		telemetryController:  access.telemetry.controller,
		events:               internalPublisher,
	})
	deviceFetcher, deviceInfoErr := deviceinfo.NewHTTPFetcher(cfg.DeviceURL, logger, deviceinfo.FetcherOptions{})

	if deviceInfoErr == nil {
		deviceinfo.NewHandler(deviceinfo.NewStore(deviceFetcher, deviceinfo.StoreOptions{}), logger).RegisterProtected(mgmtMux)
	}

	registerPalette(mux, mgmtMux, paletteStore, logger)

	gateway := registerPlugins(mux, core, intake)
	frontDoorErr := registerFrontDoor(mux, cfg, logger, verifier, reg)

	var routed http.Handler = mux

	if cfg.FrontDoorMode() {
		routed = frontend.TraversalGuard(mux)
	}

	eventLife := &eventLifecycle{
		bus:                eventBus,
		normalizer:         normalizer,
		internal:           internalPublisher,
		ingest:             ingestPublisher,
		selfUpdate:         selfUpdateService,
		selfUpdateStateDir: cfg.SelfUpdateStateDir,
		rciClient:          eventRCIClient,
		session:            access.session.service,
		reg:                reg,
		store:              store,
		logger:             logger,
		startedAt:          time.Now(),
	}

	cleanup.push("events", func() error {
		eventLife.Close()

		return nil
	})

	startupErr := errors.Join(access.session.err, access.telemetry.err, eventClientErr, frontDoorErr, deviceInfoErr)

	return &components{
		handler: httpx.ArmBodyDeadline(
			httpx.NoCORSHandler(httpx.LogMiddleware(logger, routed)),
			httpx.JSONBodyTimeout,
		),
		reg:       reg,
		runtime:   runtime,
		gateway:   gateway,
		telemetry: access.telemetry.capability,
		events:    eventLife,
		cleanup:   cleanup,
	}, startupErr
}

func backendExecConfig(cfg Config, logger *slog.Logger) backend.ExecRunnerConfig {
	return backend.ExecRunnerConfig{
		Timeout:        cfg.ExecTimeout,
		MaxBodyBytes:   cfg.MaxRequestBytes,
		MaxOutputBytes: cfg.MaxOutputBytes,
		Logger:         logger,
		Dev:            cfg.Dev,
	}
}

func registerFrontDoor(mux *http.ServeMux, cfg Config, logger *slog.Logger, verifier *authz.Verifier, reg *registry.Registry) error {
	if !cfg.FrontDoorMode() {
		return nil
	}

	proxy, err := deviceproxy.New(cfg.DeviceURL, logger)
	if err != nil {
		return fmt.Errorf("device proxy: %w", err)
	}

	proxyIntake := httpx.NewBodyIntake(httpx.DefaultBodyIntakeLimit)

	registerDeviceProxyRoutes(mux, proxy, proxyIntake, httpx.JSONBodyTimeout)

	apiReserved := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.NotFound(writer, request)
	})

	for _, prefix := range []string{"/api", "/ws"} {
		mux.Handle(prefix, apiReserved)
		mux.Handle(prefix+"/", apiReserved)
	}

	handler, err := frontend.New(cfg.FrontendDir, cfg.UserPluginsDir, func(name string) bool {
		plugin, exists := reg.Resolve(name)

		return exists && plugin.BackendServable() == nil
	})
	if err != nil {
		return fmt.Errorf("frontend handler: %w", err)
	}

	handler.Register(mux, verifier.Middleware)

	return nil
}

func registerDeviceProxyRoutes(mux *http.ServeMux, proxy http.Handler, intake *httpx.BodyIntake, timeout time.Duration) {
	proxyHandler := intake.Middleware(func(request *http.Request) httpx.BodyLimit {
		return deviceProxyBodyLimit(request, timeout)
	}, proxy)

	for _, prefix := range deviceProxyPrefixes {
		mux.Handle(prefix, proxyHandler)
		mux.Handle(prefix+"/", proxyHandler)
	}
}

func deviceProxyBodyLimit(request *http.Request, timeout time.Duration) httpx.BodyLimit {
	maxBytes := int64(1 << 20)

	for _, prefix := range []string{"/auth", "/ci"} {
		if request.URL.Path == prefix || strings.HasPrefix(request.URL.Path, prefix+"/") {
			maxBytes = 16 << 10

			break
		}
	}

	return httpx.BodyLimit{MaxBytes: maxBytes, Timeout: timeout, TooLargeCode: httpx.CodeBodyTooLarge}
}

func rejectWebSocketBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.ContentLength != 0 {
			writer.Header().Set("Connection", "close")
			httpx.WriteError(writer, nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "websocket requests must not have a body"))

			return
		}

		next.ServeHTTP(writer, request)
	})
}

// registerMgmt mounts the session-gated management surface and returns its mux so
// other session-gated routes (e.g. protected palette) can share the gate.
func registerMgmt(mux *http.ServeMux, core daemonCore, intake *httpx.BodyIntake, services mgmtServices) *http.ServeMux {
	mgmtHandler := mgmt.New(mgmt.Config{
		StagingDir:                        core.cfg.StagingDir(),
		UserPluginsDir:                    core.cfg.UserPluginsDir,
		BuiltinPluginsDir:                 core.cfg.BuiltinPluginsDir,
		MaxUploadBytes:                    maxUploadBytes,
		Runtime:                           core.runtime,
		RuntimeResolver:                   core.reg,
		Store:                             core.store,
		OpkgManager:                       services.opkg,
		ServiceManager:                    services.service,
		Builtins:                          core.reg,
		Logger:                            core.logger,
		PersistentRCICapabilityController: services.capabilityController,
		ServiceActionRoot:                 core.lifetime,
		SelfUpdate:                        services.selfUpdate,
		TelemetryController:               services.telemetryController,
		EventPublisher:                    services.events,
	})

	mgmtMux := http.NewServeMux()

	mgmtHandler.Register(mgmtMux)
	mux.Handle("/api/mgmt/", core.verifier.Middleware(intake.Middleware(mgmt.BodyLimitForRequest(maxUploadBytes), mgmtMux)))

	return mgmtMux
}

// registerAccess mounts the consent/diagnostics surface and assembles the
// persistent RCI session and telemetry subsystems.
func registerAccess(mux *http.ServeMux, core daemonCore, intake *httpx.BodyIntake) accessAssembly {
	accessMux := http.NewServeMux()

	diagnostics.New(diagnostics.Config{
		LogFile:      core.cfg.DiagnosticsLogFile,
		CrashLogFile: core.cfg.DiagnosticsCrashLogFile,
		Plugins:      func() []diagnostics.Plugin { return diagnosticsPlugins(core.reg, core.runtime) },
	}).Register(accessMux)

	session := assembleRCISession(core, accessMux, reconcileBackends(core))
	telemetry := assembleTelemetry(core, accessMux, session)

	// Keep the route mounted in dev so the host exercises the same consent contract;
	// the verifier still bypasses only session validation when core.cfg.Dev is true.
	accessLimit := func(*http.Request) httpx.BodyLimit {
		return httpx.BodyLimit{MaxBytes: httpx.MaxJSONBodyBytes, Timeout: httpx.JSONBodyTimeout, TooLargeCode: httpx.CodeBodyTooLarge}
	}

	mux.Handle("/api/mndw/", core.verifier.Middleware(intake.Middleware(accessLimit, accessMux)))

	return accessAssembly{session: session, telemetry: telemetry}
}

// registerPalette mounts the public palette route and its session-gated counterpart.
func registerPalette(mux *http.ServeMux, mgmtMux *http.ServeMux, paletteStore *palette.Store, logger *slog.Logger) {
	paletteHandler := palette.NewHandler(paletteStore, logger)

	paletteHandler.RegisterPublic(mux)
	paletteHandler.RegisterProtected(mgmtMux)
}

// registerPlugins mounts the single manifest backend gateway.
func registerPlugins(mux *http.ServeMux, core daemonCore, intake *httpx.BodyIntake) *backend.Gateway {
	gateway := backend.NewGateway(backend.GatewayConfig{
		BodyIntake:                intake,
		MaxRequestBytes:           core.cfg.MaxRequestBytes,
		ServiceHTTPTimeout:        core.cfg.ServiceHTTPTimeout,
		AllowSymlinkedBuiltinRoot: core.cfg.Dev,
		ActivationGates:           core.activationGates,
	}, core.reg, core.verifier, core.runtime, core.logger)

	gateway.Register(mux)

	return gateway
}

func diagnosticsPlugins(reg *registry.Registry, runtime *backend.Runtime) []diagnostics.Plugin {
	plugins := make([]diagnostics.Plugin, 0)

	for _, plugin := range reg.AllBackendPlugins() {
		if plugin.Manifest == nil || plugin.Manifest.Backend.Kind != manifest.BackendKindService {
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

func serveWithDrain(ctx context.Context, srv *http.Server, listener net.Listener, logger *slog.Logger, onShutdown func(), drainTimeout time.Duration) error {
	if drainTimeout <= 0 {
		drainTimeout = defaultHTTPDrainTimeout
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
