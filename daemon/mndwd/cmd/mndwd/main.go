// Command mndwd is the mndw device daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"

	"mndwd/internal/authz"
	"mndwd/internal/backend"
	"mndwd/internal/diagnostics"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/palette"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// version is stamped at build time via -ldflags "-X main.version=<v>" and
// single-sourced from the root package.json.
var version = "dev"

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

	verifier := authz.New(cfg.RouterURL, cfg.Dev, logger, authz.Options{})
	c := assemble(cfg, store, paletteStore, verifier, logger)

	// run owns all lifetimes: the signal context drives graceful HTTP shutdown, and
	// background install work runs under a child so a signal cancels installs
	// immediately — without waiting for HTTP drain.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Dependency installation is an explicit management operation. Startup only
	// reconciles already-approved service manifests; it never runs opkg retries or
	// executes plugin commands before the listener is available.
	c.runtime.Reconcile(ctx, c.reg.AllBackendPlugins())

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           c.handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	var closePersistentOnce sync.Once
	closePersistent := func() {
		closePersistentOnce.Do(c.closePersistentSession)
	}
	err = serveWithDrain(ctx, srv, logger, closePersistent, cfg.HTTPDrainTimeout)
	closePersistent()

	if shutdownErr := c.runtime.Shutdown(context.Background()); shutdownErr != nil {
		logger.Error("v3 backend shutdown failed", "error", shutdownErr)
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
	closePersistentSession func()
}

// assemble builds the fully-wired daemon. Kept separate from run so the integration
// test can drive the exact same wiring over httptest.
func assemble(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger) components {
	reg := registry.NewWithLogger(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir, logger)
	opkgMgr := opkg.New(cfg.Opkg, logger)
	runtimeRoot := cfg.PluginRuntimeRoot
	if runtimeRoot == "" {
		runtimeRoot = defaultPluginRuntimeRoot
	}
	runtime := backend.NewRuntime(backend.RuntimeConfig{
		RuntimeRoot:    runtimeRoot,
		PluginDataRoot: filepath.Join(cfg.DataDir, "plugin-data"),
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
			ReadinessTimeout: cfg.ServiceHTTPTimeout,
			StopTimeout:      cfg.ServiceStopTimeout,
			FinalReapTimeout: cfg.FinalReapTimeout,
			Logger:           logger,
		},
	})

	mux := http.NewServeMux()
	accessRegistration := registerAccess(mux, cfg, store, reg, runtimeRoot, runtime, verifier, logger)
	mgmtMux := registerMgmt(mux, cfg, store, opkgMgr, reg, runtime, accessRegistration.permissionController, verifier, logger)
	registerPalette(mux, mgmtMux, paletteStore, logger)
	gateway := registerPlugins(mux, cfg, reg, verifier, runtime, logger)
	runtime.SetMaintenanceHooks(gateway.BeginPluginMaintenance, gateway.BeginPlatformMaintenance, gateway.EndPluginMaintenance)

	return components{
		handler:                httpx.NoCORSHandler(httpx.LogMiddleware(logger, mux)),
		reg:                    reg,
		runtime:                runtime,
		gateway:                gateway,
		closePersistentSession: accessRegistration.close,
	}
}

// registerMgmt mounts the session-gated management surface and returns its mux so
// other session-gated routes (e.g. protected palette) can share the gate.
func registerMgmt(mux *http.ServeMux, cfg Config, store *state.Store, opkgMgr opkg.Manager, reg *registry.Registry, runtime *backend.RuntimeImpl, permissionController mgmt.PersistentRCIPermissionController, verifier *authz.Verifier, logger *slog.Logger) *http.ServeMux {
	mgmtHandler := mgmt.New(mgmt.Config{
		StagingDir:                        cfg.StagingDir(),
		UserPluginsDir:                    cfg.UserPluginsDir,
		BuiltinPluginsDir:                 cfg.BuiltinPluginsDir,
		MaxUploadBytes:                    maxUploadBytes,
		Runtime:                           runtime,
		PersistentRCIPermissionController: permissionController,
	}, store, opkgMgr, reg, logger)

	mgmtMux := http.NewServeMux()
	mgmtHandler.Register(mgmtMux)
	mux.Handle("/api/mgmt/", verifier.Middleware(mgmtMux))

	return mgmtMux
}

// registerAccess mounts the consent/diagnostics surface plus the persistent RCI
// session, returning the session's cleanup func.
func registerAccess(mux *http.ServeMux, cfg Config, store *state.Store, reg *registry.Registry, runtimeRoot string, v3Runtime *backend.RuntimeImpl, verifier *authz.Verifier, logger *slog.Logger) persistentSessionRegistration {
	accessMux := http.NewServeMux()
	diagnosticsLogFile := cfg.DiagnosticsLogFile
	if diagnosticsLogFile == "" {
		diagnosticsLogFile = defaultDiagnosticsLogFile
	}
	diagnostics.New(diagnostics.Config{
		LogFile: diagnosticsLogFile,
		Plugins: diagnosticsPlugins(reg, v3Runtime),
	}).Register(accessMux)
	registration := assembleRCISession(cfg, store, reg, runtimeRoot, accessMux, logger)
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

// registerPlugins mounts the single manifest-v3 backend gateway.
func registerPlugins(mux *http.ServeMux, cfg Config, reg *registry.Registry, verifier *authz.Verifier, runtime *backend.RuntimeImpl, logger *slog.Logger) *backend.Gateway {
	v3Gateway := backend.NewGateway(backend.GatewayConfig{
		MaxRequestBytes:    cfg.MaxRequestBytes,
		ServiceHTTPTimeout: cfg.ServiceHTTPTimeout,
	}, reg, verifier, runtime.ExecRunner(), runtime.Supervisor(), logger)
	v3Gateway.Register(mux)
	return v3Gateway
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
	return serveWithDrain(ctx, srv, logger, onShutdown, 10*time.Second)
}

func serveWithDrain(ctx context.Context, srv *http.Server, logger *slog.Logger, onShutdown func(), drainTimeout time.Duration) error {
	if drainTimeout <= 0 {
		drainTimeout = 35 * time.Second
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("mndwd listening", "addr", srv.Addr, "version", version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err

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
