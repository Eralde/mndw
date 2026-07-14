// Command mndwd is the mndw device daemon. It replaces v1's CGI/sh machinery and
// the WS gateway with a single Go process (design §5). Phase 2a wired the management
// API (upload/approve/deny/delete/list); Phase 2b adds the session gate plus the
// plugin HTTP dispatcher and WS proxy. opkg + backend.daemon lifecycle land in 2c.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mndwd/internal/authz"
	"mndwd/internal/dispatch"
	"mndwd/internal/httpx"
	"mndwd/internal/lifecycle"
	"mndwd/internal/manifest"
	"mndwd/internal/mgmt"
	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/state"
	"mndwd/internal/wsproxy"
)

// version is stamped at build time via -ldflags "-X main.version=<v>"; design §9
// single-sources it from the root package.json.
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

	verifier := authz.New(cfg.RouterURL, cfg.Dev, logger, authz.Options{})
	handler, life, reg := assemble(cfg, store, verifier, logger)

	// Start the backend.daemon of every already-approved+enabled plugin (design §5.2:
	// daemons start on startup). Stop them on graceful shutdown.
	startupActivate(reg, life, store, logger)
	defer shutdownDaemons(reg, life, store, logger)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	return serve(srv, logger)
}

// assemble builds the fully-wired HTTP handler plus the lifecycle manager and
// registry the startup/shutdown hooks need. Kept separate from run so the
// integration test can drive the exact same wiring over httptest.
func assemble(cfg Config, store *state.Store, verifier *authz.Verifier, logger *slog.Logger) (http.Handler, *lifecycle.Manager, *registry.Registry) {
	reg := registry.New(store, cfg.UserPluginsDir, cfg.BuiltinPluginsDir)
	opkgMgr := opkg.New(cfg.Opkg, logger)
	life := lifecycle.New(logger)

	mgmtHandler := mgmt.New(mgmt.Config{
		StagingDir:        cfg.StagingDir(),
		UserPluginsDir:    cfg.UserPluginsDir,
		BuiltinPluginsDir: cfg.BuiltinPluginsDir,
		MaxUploadBytes:    maxUploadBytes,
	}, store, opkgMgr, life, logger)

	dispatchHandler := dispatch.New(dispatch.Config{
		Timeout:           cfg.ExecTimeout,
		MaxRequestBytes:   cfg.MaxRequestBytes,
		MaxConcurrentExec: cfg.MaxConcurrentExec,
		Dev:               cfg.Dev,
	}, reg, verifier, logger)

	wsHandler := wsproxy.New(reg, verifier, logger)

	mux := http.NewServeMux()
	// The whole management surface is session-gated; dispatch and ws gate themselves
	// (per-plugin, honoring backend.public), so they take the raw verifier.
	mgmtMux := http.NewServeMux()
	mgmtHandler.Register(mgmtMux)
	mux.Handle("/api/mgmt/", verifier.Middleware(mgmtMux))
	dispatchHandler.Register(mux)
	wsHandler.Register(mux)

	return httpx.LogMiddleware(logger, mux), life, reg
}

// startupActivate starts the backend.daemon of each approved+enabled user plugin. A
// hook failure is logged, never fatal — one broken plugin must not stop the daemon.
func startupActivate(reg *registry.Registry, life *lifecycle.Manager, store *state.Store, logger *slog.Logger) {
	forEachDaemonPlugin(reg, store, func(name, dir string, d *manifest.Daemon) {
		if err := life.Start(name, dir, d.Start); err != nil {
			logger.Error("startup daemon activation failed", "plugin", name, "error", err)
		}
	})
}

// shutdownDaemons stops the backend.daemon of each approved+enabled user plugin on
// graceful shutdown so no orphaned processes survive the daemon.
func shutdownDaemons(reg *registry.Registry, life *lifecycle.Manager, store *state.Store, logger *slog.Logger) {
	forEachDaemonPlugin(reg, store, func(name, dir string, d *manifest.Daemon) {
		if err := life.Stop(name, dir, d.Stop); err != nil {
			logger.Error("shutdown daemon stop failed", "plugin", name, "error", err)
		}
	})
}

// forEachDaemonPlugin invokes fn for every approved+enabled plugin that declares a
// backend.daemon — both user plugins tracked in state and builtins discovered on disk.
func forEachDaemonPlugin(reg *registry.Registry, store *state.Store, fn func(name, dir string, d *manifest.Daemon)) {
	seen := make(map[string]bool)

	snap := store.Snapshot()
	for name, rec := range snap.Plugins {
		if rec.Approval != state.ApprovalApproved || !rec.Enabled {
			continue
		}
		plugin, ok := reg.Resolve(name)
		if !ok || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Daemon == nil {
			continue
		}
		fn(name, plugin.Dir, plugin.Manifest.Backend.Daemon)
		seen[name] = true
	}

	for _, plugin := range reg.ListBuiltins() {
		if seen[plugin.Name] {
			continue
		}
		if plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Daemon == nil {
			continue
		}
		fn(plugin.Name, plugin.Dir, plugin.Manifest.Backend.Daemon)
	}
}

// serve runs the HTTP server until a termination signal arrives, then shuts down
// gracefully.
func serve(srv *http.Server, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		return srv.Shutdown(shutdownCtx)
	}
}
