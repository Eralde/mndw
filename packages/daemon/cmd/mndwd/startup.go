package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"mndwd/internal/opkg"
	"mndwd/internal/readiness"
	"mndwd/internal/registry"
)

// daemonStarter runs a plugin's daemon start hook. Satisfied by *lifecycle.Manager;
// declared here so the coordinator depends on the behavior, not the type.
type daemonStarter interface {
	Start(name, dir, start string) error
}

// daemonStopper runs a plugin's daemon stop hook. Satisfied by *lifecycle.Manager;
// declared here so shutdown depends on the behavior, not the type.
type daemonStopper interface {
	Stop(name, dir, stop string) error
}

// startupCoordinator owns background installation of builtin opkg dependencies and
// the chained start of those builtins' daemons. Builtins install off the critical path
// so the HTTP surface can serve immediately.
type startupCoordinator struct {
	reg     *registry.Registry
	mgr     opkg.Manager
	life    daemonStarter
	tracker *readiness.Tracker
	delays  []time.Duration
	logger  *slog.Logger

	wg sync.WaitGroup
	// deferred is the set of dep-declaring builtins whose daemon start is chained
	// behind the background install. Written once in PreRegister.
	deferred map[string]bool
	// started records every builtin whose Start hook was actually invoked. Written
	// only by the background goroutine; read only after Wait().
	started map[string]bool
}

func newStartupCoordinator(reg *registry.Registry, mgr opkg.Manager, life daemonStarter, tracker *readiness.Tracker, delays []time.Duration, logger *slog.Logger) *startupCoordinator {
	return &startupCoordinator{
		reg:      reg,
		mgr:      mgr,
		life:     life,
		tracker:  tracker,
		delays:   delays,
		logger:   logger,
		deferred: make(map[string]bool),
		started:  make(map[string]bool),
	}
}

// PreRegister marks every builtin that declares backend.opkg as installing. It
// must run before the HTTP listener binds so initial list requests observe installing.
func (c *startupCoordinator) PreRegister() {
	for _, plugin := range c.reg.ListBuiltins() {
		if plugin.Manifest.Backend == nil || len(plugin.Manifest.Backend.Opkg) == 0 {
			continue
		}
		c.deferred[plugin.Name] = true
		c.tracker.Set(plugin.Name, readiness.StateInstalling)
	}
}

// Deferred reports whether a builtin daemon start is chained behind dependency
// installation.
func (c *startupCoordinator) Deferred(name string) bool {
	return c.deferred[name]
}

// Started reports whether a builtin's daemon Start hook was invoked. Valid only
// after Wait.
func (c *startupCoordinator) Started(name string) bool {
	return c.started[name]
}

// Run spawns the sequential background install worker. The opkg lock is global, so
// parallel installation provides no benefit.
func (c *startupCoordinator) Run(ctx context.Context) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.installAll(ctx)
	}()
}

// Wait joins the background worker.
func (c *startupCoordinator) Wait() {
	c.wg.Wait()
}

func (c *startupCoordinator) installAll(ctx context.Context) {
	for _, plugin := range c.reg.ListBuiltins() {
		if !c.deferred[plugin.Name] {
			continue
		}
		pkgs := plugin.Manifest.Backend.Opkg

		if err := c.installWithRetry(ctx, plugin.Name, pkgs); err != nil {
			if ctx.Err() != nil {
				c.logger.Warn("builtin opkg dependency install canceled by shutdown",
					"plugin", plugin.Name, "packages", pkgs)

				return
			}
			c.tracker.Set(plugin.Name, readiness.StateFailed)
			c.logger.Error("builtin opkg dependency install failed",
				"plugin", plugin.Name, "packages", pkgs, "error", err)

			continue
		}
		if ctx.Err() != nil {
			return
		}

		c.startDaemon(plugin)
		c.tracker.MarkReady(plugin.Name)
		c.logger.Info("builtin opkg dependencies installed", "plugin", plugin.Name, "packages", pkgs)
	}
}

// installWithRetry runs one install attempt plus one per configured delay.
func (c *startupCoordinator) installWithRetry(ctx context.Context, name string, pkgs []string) error {
	var err error
	for attempt := 0; ; attempt++ {
		err = c.installOnce(ctx, pkgs)
		if err == nil || attempt >= len(c.delays) || ctx.Err() != nil {
			return err
		}
		delay := c.delays[attempt]
		c.logger.Warn("builtin opkg dependency install failed; retrying",
			"plugin", name, "packages", pkgs, "delay", delay, "error", err)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// installOnce bounds one attempt while preserving cancellation from shutdown.
func (c *startupCoordinator) installOnce(ctx context.Context, pkgs []string) error {
	ctx, cancel := context.WithTimeout(ctx, opkgInstallTimeout)
	defer cancel()

	return c.mgr.Install(ctx, pkgs)
}

// startDaemon records a start before invoking its hook so shutdown can stop a
// daemon even if cancellation races the hook call.
func (c *startupCoordinator) startDaemon(plugin *registry.Plugin) {
	backend := plugin.Manifest.Backend
	if backend == nil || backend.Daemon == nil {
		return
	}
	c.started[plugin.Name] = true
	if err := c.life.Start(plugin.Name, plugin.Dir, backend.Daemon.Start); err != nil {
		c.logger.Error("builtin daemon start failed after dependency install",
			"plugin", plugin.Name, "error", err)
	}
}
