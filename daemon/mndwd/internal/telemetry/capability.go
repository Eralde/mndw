package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
	"mndwd/internal/telemetry/sessions"
)

type CapabilityConfig struct {
	RRDDir             string
	LoadSampler        Sampler
	TemperatureSampler Sampler
	Clock              clock.BootClock
	Evidence           clock.EvidenceSource
	Policy             Policy
	FileSystem         journal.FileSystem
	Locker             journal.Locker
	SessionConfigured  func() bool
	Now                func() time.Time
	Wait               func(context.Context, time.Duration) error
	DesiredEnabled     func() bool
	Logger             *slog.Logger
	RetryBackoff       []time.Duration
	Lifetime           context.Context
}

type Capability struct {
	config CapabilityConfig

	mu            sync.Mutex
	enabled       bool
	provider      journal.StorageProvider
	history       *History
	snapshotCache *SnapshotCache
	pipeline      *Pipeline
	pipelineDone  chan struct{}
	status        PipelineStatus
	retryCancel   context.CancelFunc
	retryDone     chan struct{}
	starting      bool
}

func NewCapability(config CapabilityConfig) (*Capability, error) {
	if config.RRDDir == "" {
		config.RRDDir = "/opt/var/lib/mndw/rrd"
	}

	if config.Now == nil {
		config.Now = time.Now
	}

	if config.Wait == nil {
		config.Wait = waitContext
	}

	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	if config.Lifetime == nil {
		config.Lifetime = context.Background()
	}

	if config.Clock == nil {
		config.Clock = clock.NewBootClock()
	}

	if config.Policy.AcquireEvery == 0 {
		config.Policy = DefaultPolicy()
	}

	if config.FileSystem == nil {
		config.FileSystem = journal.OSFileSystem{}
	}

	if config.Locker == nil {
		config.Locker = journal.OSLocker{}
	}

	enabled := false

	if config.DesiredEnabled != nil {
		enabled = config.DesiredEnabled()
	}

	paths, err := journal.PathsFromRRDDir(config.RRDDir)
	if err != nil {
		return nil, err
	}

	provider, err := journal.NewStorageProvider(paths, config.FileSystem, config.Locker, config.Policy.Journal)
	if err != nil {
		return nil, err
	}

	history, err := NewHistory(config.Policy.Journal, DefaultSeriesSpecs())
	if err != nil {
		return nil, err
	}

	snapshotCache := NewSnapshotCache(history, config.Now, config.SessionConfigured)
	capability := &Capability{config: config, enabled: enabled, provider: provider, history: history, snapshotCache: snapshotCache}
	capability.status = PipelineStatus{Storage: provider.CurrentStatus()}

	return capability, nil
}

func (c *Capability) Start(ctx context.Context) error {
	c.mu.Lock()

	if c.pipeline != nil || c.starting {
		c.mu.Unlock()

		return nil
	}

	enabled := c.enabled

	c.starting = true

	c.mu.Unlock()

	samplers := map[uint16]Sampler{}

	if c.config.LoadSampler != nil {
		samplers[1] = c.config.LoadSampler
	}

	if c.config.TemperatureSampler != nil {
		samplers[2] = c.config.TemperatureSampler
	}

	c.snapshotCache.SetSupportedSeries(supportedFromSamplers(samplers))

	defer func() {
		c.mu.Lock()

		c.starting = false

		c.mu.Unlock()
	}()

	// Hydrate retained history even when gathering is disabled. Acquisition starts
	// only after writable recovery succeeds.
	opened, err := c.provider.Reopen(ctx)
	if err != nil {
		c.setStatusError(err)

		_ = c.history.restore(ctx, journal.StatusUnavailable, nil, nil, journal.RetentionInput{})

		_ = c.refreshSnapshot(ctx)

		if !enabled {
			return nil
		}

		return err
	}

	c.mu.Lock()

	c.status.Storage = opened.Status

	c.mu.Unlock()

	if opened.Status.Mode == journal.StatusUnavailable {
		if err := c.history.restore(ctx, journal.StatusUnavailable, nil, nil, journal.RetentionInput{}); err != nil {
			return err
		}

		_ = c.refreshSnapshot(ctx)

		if !enabled {
			return nil
		}

		return errors.New("telemetry: journal unavailable")
	}

	// Collect garbage around the restore so the delta approximates the heap
	// the raw store adds in steady state.
	heapBefore := heapAllocBytes(true)
	started := time.Now()

	if err := c.history.restore(ctx, opened.Status.Mode, opened.Reader, opened.Writer, journal.RetentionInput{}); err != nil {
		c.setStatusError(err)

		return err
	}

	elapsed := time.Since(started)
	heapAfter := heapAllocBytes(true)

	c.config.Logger.Info("telemetry: history restored",
		"durationMs", durationMs(elapsed),
		"appliedThrough", c.history.AppliedThrough(),
		"heapBeforeBytes", heapBefore,
		"heapAfterBytes", heapAfter,
		"heapDeltaBytes", int64(heapAfter)-int64(heapBefore),
	)

	c.mu.Lock()

	c.status.DurableThrough = c.history.AppliedThrough()

	c.mu.Unlock()

	snapshotErr := c.refreshSnapshot(ctx)

	if snapshotErr != nil {
		c.setStatusError(snapshotErr)
	} else if opened.Status.Mode == journal.StatusReady && opened.Writer != nil {
		if err := journal.CleanupLegacyArtifacts(c.config.FileSystem, opened.Writer.Paths()); err != nil {
			c.setStatusError(err)
			c.config.Logger.Warn("telemetry legacy artifact cleanup failed", "error", err)
		}
	}

	if !enabled {
		return nil
	}

	if opened.Status.Mode != journal.StatusReady || opened.Writer == nil {
		return errors.New("telemetry: writable journal required for acquisition")
	}

	if len(samplers) == 0 {
		return errors.New("telemetry: no sampler configured")
	}

	options := []PipelineOption{WithHistory(c.history), WithLogger(c.config.Logger)}

	refresher := &snapshotRefresher{cache: c.snapshotCache}
	options = append(options, WithSnapshotRefresher(refresher))

	pipeline, err := NewPipeline(c.config.Policy, c.config.Clock, c.config.Evidence, c.provider, samplers, options...)
	if err != nil {
		return err
	}

	c.mu.Lock()

	if !c.enabled {
		c.mu.Unlock()

		return nil
	}

	c.pipeline = pipeline
	c.pipelineDone = make(chan struct{})

	done := c.pipelineDone

	c.mu.Unlock()

	go func() {
		defer close(done)

		if err := pipeline.Run(c.config.Lifetime); err != nil {
			c.config.Logger.Warn("telemetry pipeline stopped", "error", err)
		}
	}()

	return nil
}

// SessionReader exposes bounded diagnostic session access. It serves read-only
// validated records and never repairs or writes storage.
func (c *Capability) SessionReader() sessions.Reader {
	c.mu.Lock()

	provider := c.provider
	policy := c.config.Policy

	c.mu.Unlock()

	if provider == nil {
		return nil
	}

	return sessions.NewReader(provider, func() sessions.Status {
		return sessionStatus(c.Status())
	}, policy.Journal)
}

func sessionStatus(status PipelineStatus) sessions.Status {
	return sessions.Status{
		PendingSamples: status.PendingSamples,
		Error:          status.Error,
		Loss:           status.Loss,
		Coverage:       status.Coverage,
	}
}

// SnapshotCache returns the cache owned by this capability.
func (c *Capability) SnapshotCache() *SnapshotCache {
	return c.snapshotCache
}

func (c *Capability) refreshSnapshot(ctx context.Context) error {
	started := time.Now()

	if _, err := c.snapshotCache.Refresh(ctx, c.Status()); err != nil {
		c.config.Logger.Warn("telemetry initial snapshot refresh failed", "error", err)

		return err
	}

	c.config.Logger.Info("telemetry: initial snapshot refreshed", "durationMs", durationMs(time.Since(started)))

	return nil
}

// Status reports the last observed pipeline and storage state.
func (c *Capability) Status() PipelineStatus {
	c.mu.Lock()

	defer c.mu.Unlock()

	status := c.status

	if c.pipeline != nil {
		status = c.pipeline.Status()
	}

	return status
}

// StorageStatus reports the provider's recovery status for diagnostics.
func (c *Capability) StorageStatus() journal.RecoveryStatus {
	return c.provider.CurrentStatus()
}

func (c *Capability) setStatusError(err error) {
	c.mu.Lock()

	defer c.mu.Unlock()

	c.status.Error = err.Error()
}

func (c *Capability) StartWithRetry(ctx context.Context) error {
	retryCtx, retryCancel := context.WithCancel(ctx)
	retryDone := make(chan struct{})

	c.mu.Lock()

	c.retryCancel = retryCancel
	c.retryDone = retryDone

	c.mu.Unlock()

	defer func() {
		retryCancel()
		close(retryDone)
		c.mu.Lock()

		if c.retryDone == retryDone {
			c.retryCancel = nil
			c.retryDone = nil
		}

		c.mu.Unlock()
	}()

	backoff := c.config.RetryBackoff

	if len(backoff) == 0 {
		backoff = []time.Duration{time.Second, 5 * time.Second, 30 * time.Second}
	}

	for index := 0; ; index++ {
		enabled := c.IsEnabled()

		if !enabled {
			c.mu.Lock()

			c.enabled = false

			c.mu.Unlock()

			return c.Start(retryCtx)
		}

		if err := c.Start(retryCtx); err == nil {
			return nil
		} else {
			c.config.Logger.Error("telemetry start failed", "error", err)
		}

		delay := backoff[len(backoff)-1]

		if index < len(backoff) {
			delay = backoff[index]
		}

		if err := c.config.Wait(retryCtx, delay); err != nil {
			return err
		}
	}
}

// History returns the retained raw history projection.
func (c *Capability) History() *History { return c.history }

func (c *Capability) IsEnabled() bool {
	if c.config.DesiredEnabled != nil {
		return c.config.DesiredEnabled()
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	return c.enabled
}

func (c *Capability) SetEnabled(ctx context.Context, enabled bool) error {
	c.mu.Lock()

	old := c.enabled
	c.enabled = enabled
	retryCancel := c.retryCancel

	c.mu.Unlock()

	if old == enabled {
		return nil
	}

	if !enabled {
		if err := c.cancelRetry(ctx, retryCancel); err != nil {
			return err
		}

		return c.stopPipeline(ctx)
	}

	if err := c.Start(ctx); err != nil {
		c.mu.Lock()

		c.enabled = false

		c.mu.Unlock()

		return err
	}

	return nil
}

func (c *Capability) Close(ctx context.Context) error {
	c.mu.Lock()

	c.enabled = false
	retryCancel := c.retryCancel

	c.mu.Unlock()

	if err := c.cancelRetry(ctx, retryCancel); err != nil {
		return err
	}

	if err := c.stopPipeline(ctx); err != nil {
		return err
	}

	c.mu.Lock()

	c.mu.Unlock()

	return c.provider.Close(ctx)
}

func (c *Capability) cancelRetry(ctx context.Context, retryCancel context.CancelFunc) error {
	if retryCancel == nil {
		return nil
	}

	retryCancel()
	c.mu.Lock()

	done := c.retryDone

	c.mu.Unlock()

	if done == nil {
		return nil
	}

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Capability) stopPipeline(ctx context.Context) error {
	c.mu.Lock()

	pipeline := c.pipeline
	done := c.pipelineDone
	c.pipeline = nil
	c.pipelineDone = nil

	c.mu.Unlock()

	if pipeline == nil {
		return nil
	}

	if err := pipeline.Stop(ctx); err != nil {
		return err
	}

	if done == nil {
		return nil
	}

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)

	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
