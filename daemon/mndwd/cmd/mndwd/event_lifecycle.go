package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	contractEvents "mndw.local/contracts/events"
	rci "mndw.local/rci"
	"mndwd/internal/events"
	"mndwd/internal/registry"
	"mndwd/internal/selfupdate"
	"mndwd/internal/state"
	"mndwd/internal/telemetry"
)

type selfUpdateStatusReader interface {
	Status() (selfupdate.Status, error)
}

// eventLifecycle owns the daemon's event producers and lifecycle announcements.
// run drives it from one goroutine, so it is not safe for concurrent use.
type eventLifecycle struct {
	bus                *events.Bus
	normalizer         *events.Normalizer
	internal           *events.InternalPublisher
	ingest             events.Publisher
	selfUpdate         selfUpdateStatusReader
	selfUpdateStateDir string
	annotations        *telemetry.AnnotationStore
	rciClient          *rci.Client
	reg                *registry.Registry
	store              *state.Store
	logger             *slog.Logger
	startedAt          time.Time

	cancel  context.CancelFunc
	started bool
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

		if err := publisher.PublishPluginInstalled(contractEvents.PluginInstalledPayload{Name: name, Version: derefVersion(plugin.Manifest.Version)}); err != nil {
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

		if err := publisher.PublishPluginInstalled(contractEvents.PluginInstalledPayload{Name: plugin.Name, Version: derefVersion(plugin.Manifest.Version)}); err != nil {
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

// Start launches the producers under a child of ctx and announces
// daemon.started. A second call is a no-op.
func (l *eventLifecycle) Start(ctx context.Context) error {
	if l.started {
		return nil
	}

	eventCtx, cancel := context.WithCancel(ctx)
	l.cancel = cancel

	if _, err := l.selfUpdate.Status(); err != nil {
		l.logger.Warn("self-update startup status unavailable", "error", err)
	}

	completion, completionErr := selfupdate.NewStateStore(l.selfUpdateStateDir).ConsumeCompletion()

	if completionErr == nil {
		_ = l.internal.PublishDaemonUpdated(contractEvents.DaemonUpdatedPayload{Version: completion.TargetVersion})
	} else if !errors.Is(completionErr, selfupdate.ErrNoIntent) {
		l.logger.Warn("self-update completion record unavailable", "error", completionErr)
	}

	if l.annotations != nil {
		if err := l.annotations.Start(eventCtx, l.bus); err != nil {
			cancel()

			return fmt.Errorf("start event annotations: %w", err)
		}
	}

	if l.rciClient == nil {
		l.logger.Warn("event log poller disabled: no RCI client available")
	} else {
		deviceTZ := events.QueryDeviceTimezone(eventCtx, l.rciClient)
		parser := events.NewLogParser(l.normalizer, deviceTZ, nil, l.logger)
		pollTicker := time.NewTicker(events.LogPollInterval)
		poller := events.NewLogPoller(events.LogPollerConfig{
			Source:     events.NewRCILogSource(l.rciClient),
			Parser:     parser,
			Publisher:  l.ingest,
			Ticker:     pollTicker.C,
			StopTicker: pollTicker.Stop,
			Logger:     l.logger,
		})

		go poller.Run(eventCtx)
	}

	storage := events.NewStorageMonitor("/opt", nil, l.internal, l.logger)

	go storage.Run(eventCtx)

	publishActivePluginEvents(l.reg, l.store, l.internal, l.logger)

	_ = l.internal.PublishDaemonStarted(contractEvents.DaemonStartedPayload{
		Version:  version,
		UptimeMs: time.Since(l.startedAt).Milliseconds(),
	})
	l.started = true

	return nil
}

// Stop announces daemon.stopping and cancels the producers. It does nothing
// before Start.
func (l *eventLifecycle) Stop(reason string) {
	if !l.started {
		return
	}

	_ = l.internal.PublishDaemonStopping(contractEvents.DaemonStoppingPayload{Reason: reason})

	if l.cancel != nil {
		l.cancel()
	}
}

// Close cancels the producers and flushes the annotation store. It is safe
// without Start and safe to call twice. Failures are logged, not returned.
func (l *eventLifecycle) Close() {
	if l.cancel != nil {
		l.cancel()

		l.cancel = nil
	}

	if l.annotations != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), telemetryShutdownTimeout)

		if err := l.annotations.Close(closeCtx); err != nil {
			l.logger.Warn("telemetry annotations shutdown failed", "error", err)
		}

		cancel()
	}
}
