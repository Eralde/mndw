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

	"mndwd/internal/access"
	"mndwd/internal/authz"
	"mndwd/internal/diagnostics"
	"mndwd/internal/dispatch"
	"mndwd/internal/httpx"
	"mndwd/internal/lifecycle"
	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/palette"
	"mndwd/internal/pluginruntime"
	"mndwd/internal/readiness"
	"mndwd/internal/registry"
	"mndwd/internal/state"
	"mndwd/internal/wsproxy"
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
	handler, life, reg, opkgMgr, tracker, closePersistentSession := assembleWithCleanup(cfg, store, paletteStore, verifier, logger)

	// run owns all lifetimes: the signal context drives graceful HTTP shutdown, and
	// background install work runs under a child so a signal cancels installs
	// immediately — without waiting for HTTP drain.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Builtins skip the approval flow (where user-plugin opkg deps are installed), so
	// their deps install in the background — off the critical path, so the UI's first
	// request is served immediately. Pre-registration must precede the listener bind.
	coord := newStartupCoordinator(reg, opkgMgr, life, tracker, opkgInstallRetryDelays, logger)
	coord.PreRegister()

	// Start backend.daemon hooks whose dependencies need no background install;
	// dep-declaring builtins chain behind their install.
	startupActivate(reg, life, coord.Deferred, logger)

	bgCtx, bgCancel := context.WithCancel(ctx)
	defer bgCancel()
	coord.Run(bgCtx)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	var closePersistentOnce sync.Once
	closePersistent := func() {
		closePersistentOnce.Do(closePersistentSession)
	}
	err = serve(ctx, srv, logger, closePersistent)
	closePersistent()

	// Cancel background work, join it so Start cannot race Stop, then stop daemons.
	// Deferred builtins whose Start hook never ran are excluded from shutdown.
	bgCancel()
	coord.Wait()
	shutdownDaemons(reg, life, func(name string) bool {
		return coord.Deferred(name) && !coord.Started(name)
	}, logger)

	return err
}

// assemble builds the fully-wired HTTP handler plus the lifecycle manager, registry,
// and opkg manager the startup/shutdown hooks need. Kept separate from run so the
// integration test can drive the exact same wiring over httptest.
func assemble(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger) (http.Handler, *lifecycle.Manager, *registry.Registry, opkg.Manager, *readiness.Tracker) {
	handler, life, reg, opkgMgr, tracker, _ := assembleWithCleanup(cfg, store, paletteStore, verifier, logger)
	return handler, life, reg, opkgMgr, tracker
}

func assembleWithCleanup(cfg Config, store *state.Store, paletteStore *palette.Store, verifier *authz.Verifier, logger *slog.Logger) (http.Handler, *lifecycle.Manager, *registry.Registry, opkg.Manager, *readiness.Tracker, func()) {
	reg := registry.NewWithLogger(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir, logger)
	opkgMgr := opkg.New(cfg.Opkg, logger)
	runtimeRoot := cfg.PluginRuntimeRoot
	if runtimeRoot == "" {
		runtimeRoot = filepath.Join(cfg.DataDir, "plugin-runtime")
	}
	life := lifecycle.New(logger, lifecycle.Options{RuntimeRoot: runtimeRoot})
	tracker := readiness.New()

	mgmtHandler := mgmt.New(mgmt.Config{
		StagingDir:        cfg.StagingDir(),
		UserPluginsDir:    cfg.UserPluginsDir,
		BuiltinPluginsDir: cfg.BuiltinPluginsDir,
		MaxUploadBytes:    maxUploadBytes,
	}, store, opkgMgr, life, tracker, reg, logger)

	dispatchHandler := dispatch.New(dispatch.Config{
		Timeout:           cfg.ExecTimeout,
		MaxRequestBytes:   cfg.MaxRequestBytes,
		MaxConcurrentExec: cfg.MaxConcurrentExec,
		Dev:               cfg.Dev,
		PluginRuntimeRoot: runtimeRoot,
	}, reg, verifier, logger)

	wsHandler := wsproxy.New(reg, verifier, logger)

	mux := http.NewServeMux()
	// The whole management surface is session-gated; dispatch and ws gate themselves
	// (per-plugin, honoring backend.public), so they take the raw verifier.
	mgmtMux := http.NewServeMux()
	mgmtHandler.Register(mgmtMux)
	mux.Handle("/api/mgmt/", verifier.Middleware(mgmtMux))
	accessMux := http.NewServeMux()
	access.New(store).Register(accessMux)
	diagnosticsLogFile := cfg.DiagnosticsLogFile
	if diagnosticsLogFile == "" {
		diagnosticsLogFile = defaultDiagnosticsLogFile
	}
	diagnostics.New(diagnostics.Config{
		LogFile: diagnosticsLogFile,
		Plugins: diagnosticsPlugins(reg, runtimeRoot),
	}).Register(accessMux)
	closePersistentSession := assembleRCISession(cfg, reg, runtimeRoot, accessMux, logger)
	// Keep the route mounted in dev so the host exercises the same consent contract;
	// the verifier still bypasses only session validation when cfg.Dev is true.
	mux.Handle("/api/mndw/", verifier.Middleware(accessMux))
	paletteHandler := palette.NewHandler(paletteStore, logger)
	paletteHandler.RegisterPublic(mux)
	paletteHandler.RegisterProtected(mgmtMux)
	pluginMux := http.NewServeMux()
	dispatchHandler.Register(pluginMux)
	mux.Handle("/api/plugins/", httpx.PluginNoStoreMiddleware(pluginMux))
	wsHandler.Register(mux)

	return httpx.LogMiddleware(logger, mux), life, reg, opkgMgr, tracker, closePersistentSession
}

// opkgInstallTimeout bounds one builtin's dependency install at startup (an install
// can pull over a slow link). Mirrors mgmt's opkgTimeout for the approval flow.
const opkgInstallTimeout = 3 * time.Minute

// opkgInstallRetryDelays are the waits between startup install attempts. When the ipk
// postinst starts the daemon, the parent `opkg install mndw...` still holds the global
// opkg lock, so the first attempt fails instantly — the retries land after that
// window closes (and also absorb transient boot conditions). Failures on the lock are
// instant, so the worst-case added startup delay stays close to the sum of the delays.
var opkgInstallRetryDelays = []time.Duration{5 * time.Second, 15 * time.Second}

// startupActivate starts the backend.daemon of each approved+enabled user plugin. A
// hook failure is logged, never fatal — one broken plugin must not stop the daemon.
func startupActivate(reg *registry.Registry, life daemonStarter, skip func(name string) bool, logger *slog.Logger) {
	for _, plugin := range reg.AllDaemonPlugins() {
		if skip != nil && skip(plugin.Name) {
			continue
		}
		d := plugin.Manifest.Backend.Daemon
		if err := life.Start(plugin.Name, plugin.Dir, d.Start); err != nil {
			logger.Error("startup daemon activation failed", "plugin", plugin.Name, "error", err)
		}
	}
}

// shutdownDaemons stops the backend.daemon of each approved+enabled user plugin on
// graceful shutdown so no orphaned processes survive the daemon. Plugin discovery
// order is retained only for selection; stop execution order is unspecified and
// daemonStopper implementations must support concurrent Stop calls.
func shutdownDaemons(reg *registry.Registry, life daemonStopper, skip func(name string) bool, logger *slog.Logger) {
	var wait sync.WaitGroup
	for _, plugin := range reg.AllDaemonPlugins() {
		if skip != nil && skip(plugin.Name) {
			continue
		}
		name := plugin.Name
		dir := plugin.Dir
		stopPath := plugin.Manifest.Backend.Daemon.Stop
		wait.Add(1)
		go func() {
			defer wait.Done()
			if err := life.Stop(name, dir, stopPath); err != nil {
				logger.Error("shutdown daemon stop failed", "plugin", name, "error", err)
			}
		}()
	}
	wait.Wait()
}

func diagnosticsPlugins(reg *registry.Registry, runtimeRoot string) []diagnostics.Plugin {
	plugins := make([]diagnostics.Plugin, 0)
	if runtimeRoot == "" {
		return plugins
	}

	for _, plugin := range reg.AllBackendPlugins() {
		if plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Diagnostics == nil || !*plugin.Manifest.Backend.Diagnostics {
			continue
		}
		dir, err := pluginruntime.ForPlugin(runtimeRoot, plugin.Name)
		if err != nil || dir == "" {
			continue
		}
		plugins = append(plugins, diagnostics.Plugin{ID: plugin.Name, RuntimeDir: dir})
	}
	sort.Slice(plugins, func(left, right int) bool { return plugins[left].ID < plugins[right].ID })

	return plugins
}

// serve runs the HTTP server until ctx is canceled or the listener fails, then
// shuts down gracefully.
func serve(ctx context.Context, srv *http.Server, logger *slog.Logger, onShutdown func()) error {
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
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		return srv.Shutdown(shutdownCtx)
	}
}
