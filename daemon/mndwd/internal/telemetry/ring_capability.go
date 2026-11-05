package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"mndwd/internal/mgmt"
	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/system"
	"mndwd/internal/telemetry/timekeeper"
)

const disableStopTimeout = 10 * time.Second

var errTelemetryStopping = errors.New("telemetry: previous run is still stopping")

// CapabilityConfig supplies dependencies for ring-backed telemetry.
type CapabilityConfig struct {
	RRDDir             string
	LoadSampler        Sampler
	TemperatureSampler Sampler
	NTP                system.NTPSource
	Clock              system.Clock
	FS                 ring.FS
	MaxUnsynced        time.Duration
	DesiredEnabled     func() bool
	SessionConfigured  func() bool
	Lifetime           context.Context
	Logger             *slog.Logger
	RetryBackoff       []time.Duration
	Wait               func(context.Context, time.Duration) error
	CheckFS            func(dir string) error
	Lock               func(dir string) (func() error, error)
	WaitUntil          func(ctx context.Context, bootMs int64) error
}

// Capability owns telemetry lifecycle, storage locking, and published snapshots.
type Capability struct {
	config      CapabilityConfig
	dir         string
	cache       *SnapshotCache
	mu          sync.Mutex
	enabled     bool
	closed      bool
	lockRelease func() error
	engine      *system.Engine
	runCancel   context.CancelFunc
	runDone     chan struct{}
	stopping    chan struct{}
}

// NewCapability creates a ring-backed capability without touching storage.
func NewCapability(config CapabilityConfig) (*Capability, error) {
	if config.RRDDir == "" {
		config.RRDDir = "/opt/var/lib/mndw/rrd"
	}

	if config.Clock == nil {
		clock, err := system.NewOSClock()
		if err != nil {
			return nil, err
		}

		config.Clock = clock
	}

	if config.FS == nil {
		config.FS = ring.OSFS{}
	}

	if config.Lifetime == nil {
		config.Lifetime = context.Background()
	}

	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	if config.Wait == nil {
		config.Wait = waitContext
	}

	if config.CheckFS == nil {
		config.CheckFS = ring.CheckFilesystem
	}

	if config.Lock == nil {
		config.Lock = ring.Lock
	}

	if config.WaitUntil == nil {
		config.WaitUntil = waitForBootDeadline(config.Clock)
	}

	capability := &Capability{
		config: config,
		dir:    filepath.Join(config.RRDDir, "ring"),
		cache:  NewSnapshotCache(time.Now, config.SessionConfigured),
	}

	if config.DesiredEnabled != nil {
		capability.enabled = config.DesiredEnabled()
	}

	capability.cache.SetSupportedSeries(supportedFromSamplers(map[uint16]Sampler{
		1: config.LoadSampler,
		2: config.TemperatureSampler,
	}))

	return capability, nil
}

// Start starts gathering or publishes retained history in read-only mode.
func (c *Capability) Start(ctx context.Context) error {
	c.mu.Lock()

	defer c.mu.Unlock()

	if c.closed {
		return errors.New("telemetry: ring capability is closed")
	}

	return c.startLocked(ctx)
}

func (c *Capability) startLocked(ctx context.Context) error {
	if c.stopping != nil {
		select {
		case <-c.stopping:
			c.stopping = nil
		default:
			return errTelemetryStopping
		}
	}

	if c.runCancel != nil {
		return nil
	}

	if !c.enabled {
		entries, err := c.config.FS.ReadDir(c.dir)
		_ = entries

		if errors.Is(err, fs.ErrNotExist) {
			c.publishEmpty(false)

			return nil
		}

		if err != nil {
			c.publishEmpty(false)

			return err
		}

		if err := c.config.CheckFS(c.dir); err != nil {
			c.publishEmpty(false)

			return nil
		}

		if err := system.PublishReadOnly(system.Config{
			Dir:   c.dir,
			FS:    c.config.FS,
			Clock: c.config.Clock,
			Publish: func(view system.View) {
				c.cache.PublishView(view)
			},
		}); err != nil {
			c.publishEmpty(false)

			return err
		}

		c.setGathering(false)

		return nil
	}

	if err := c.config.FS.MkdirAll(c.dir, 0o755); err != nil {
		c.publishEmpty(true)

		return err
	}

	if err := c.config.FS.MkdirAll(filepath.Join(c.dir, "pending"), 0o755); err != nil {
		c.publishEmpty(true)

		return err
	}

	if err := c.config.CheckFS(c.dir); err != nil {
		c.publishEmpty(true)

		return err
	}

	if c.lockRelease == nil {
		release, err := c.config.Lock(c.dir)
		if err != nil {
			c.publishEmpty(true)

			return err
		}

		c.lockRelease = release
	}

	engine := system.NewEngine(system.Config{
		Dir:       c.dir,
		FS:        c.config.FS,
		Clock:     c.config.Clock,
		NTP:       c.config.NTP,
		Collect:   NewCollector(c.config.LoadSampler, c.config.TemperatureSampler),
		Publish:   c.cache.PublishView,
		Keeper:    timekeeper.DefaultConfig(),
		SyncEvery: c.config.MaxUnsynced,
		Logger:    c.config.Logger,
	})

	if err := engine.Start(ctx); err != nil {
		c.publishEmpty(true)

		return err
	}

	if err := cleanupJournalArtifacts(c.config.FS, c.config.RRDDir); err != nil {
		c.config.Logger.Error("telemetry legacy cleanup failed", "error", err)
	}

	runCtx, runCancel := context.WithCancel(c.config.Lifetime)
	runDone := make(chan struct{})
	c.engine = engine
	c.runCancel = runCancel
	c.runDone = runDone

	go func() {
		defer close(runDone)

		if err := system.Run(runCtx, engine, c.config.WaitUntil); err != nil && !errors.Is(err, context.Canceled) {
			c.config.Logger.Error("telemetry ring engine stopped", "error", err)
		}
	}()

	return nil
}

// StartWithRetry retries startup using the established 1s, 5s, 30s backoff.
func (c *Capability) StartWithRetry(ctx context.Context) error {
	backoff := c.config.RetryBackoff

	if len(backoff) == 0 {
		backoff = []time.Duration{time.Second, 5 * time.Second, 30 * time.Second}
	}

	for attempt := 0; ; attempt++ {
		if !c.IsEnabled() {
			return c.Start(ctx)
		}

		if err := c.Start(ctx); err == nil {
			return nil
		} else {
			c.config.Logger.Error("telemetry ring start failed", "error", err)
		}

		delay := backoff[len(backoff)-1]

		if attempt < len(backoff) {
			delay = backoff[attempt]
		}

		if err := c.config.Wait(ctx, delay); err != nil {
			return err
		}
	}
}

func waitContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)

	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Close stops gathering and releases the directory lock. Repeated calls are safe.
func (c *Capability) Close(ctx context.Context) error {
	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()

		return nil
	}

	c.enabled = false
	done := c.beginStopLocked()
	c.closed = true

	c.setGathering(false)

	release := c.lockRelease

	c.mu.Unlock()

	if err := c.waitStopped(ctx, done); err != nil {
		c.config.Logger.Warn("telemetry stop still in progress", "error", err)

		return fmt.Errorf("telemetry: run did not stop: %w", err)
	}

	c.mu.Lock()

	c.lockRelease = nil

	c.mu.Unlock()

	if release != nil {
		return release()
	}

	return nil
}

// IsEnabled reports whether gathering is currently enabled.
func (c *Capability) IsEnabled() bool {
	c.mu.Lock()

	defer c.mu.Unlock()

	return c.enabled && !c.closed
}

// SetEnabled changes gathering while keeping the writer lock until Close.
func (c *Capability) SetEnabled(ctx context.Context, enabled bool) error {
	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()

		return errors.New("telemetry: ring capability is closed")
	}

	if !enabled {
		c.enabled = false
		done := c.beginStopLocked()

		c.setGathering(false)
		c.mu.Unlock()

		stopCtx, cancel := context.WithTimeout(ctx, disableStopTimeout)

		defer cancel()

		if err := c.waitStopped(stopCtx, done); err != nil {
			c.config.Logger.Warn("telemetry stop still in progress", "error", err)
		}

		return nil
	}

	if c.enabled {
		err := c.startLocked(ctx)

		c.mu.Unlock()

		return err
	}

	c.enabled = true

	if err := c.startLocked(ctx); err != nil {
		c.enabled = false

		c.setGathering(false)
		c.mu.Unlock()

		return err
	}

	c.mu.Unlock()

	return nil
}

// SnapshotCache returns the immutable snapshot cache owned by the capability.
func (c *Capability) SnapshotCache() *SnapshotCache { return c.cache }

func (c *Capability) beginStopLocked() <-chan struct{} {
	if c.runCancel == nil {
		return c.stopping
	}

	c.runCancel()

	done := c.runDone
	c.stopping = done
	c.runCancel = nil
	c.runDone = nil
	c.engine = nil

	return done
}

func (c *Capability) waitStopped(ctx context.Context, done <-chan struct{}) error {
	if done == nil {
		return nil
	}

	select {
	case <-done:
		c.mu.Lock()

		if c.stopping == done {
			c.stopping = nil
		}

		c.mu.Unlock()

		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Capability) publishEmpty(enabled bool) {
	snapshot := emptySnapshot(enabled)
	snapshot.Clock = &ClockMetadata{State: "unanchored"}
	snapshot.SessionConfigured = c.config.SessionConfigured != nil && c.config.SessionConfigured()

	c.cache.mu.Lock()

	supported := make(map[uint16]bool, len(c.cache.supportedSeries))

	for series, value := range c.cache.supportedSeries {
		supported[series] = value
	}

	c.cache.mu.Unlock()
	applySupportedSeries(snapshot, supported)
	c.cache.Publish(snapshot)
}

func (c *Capability) setGathering(enabled bool) {
	snapshot, err := c.cache.Get(context.Background(), true)
	if err != nil || snapshot == nil {
		c.publishEmpty(enabled)

		return
	}

	snapshot.Gathering.Enabled = enabled

	c.cache.Publish(snapshot)
}

func waitForBootDeadline(clock system.Clock) func(context.Context, int64) error {
	return func(ctx context.Context, deadlineMs int64) error {
		for {
			reading, err := clock.Read()
			if err != nil {
				return err
			}

			remaining := deadlineMs - reading.BootMs

			if remaining <= 0 {
				return nil
			}

			delay := time.Duration(remaining) * time.Millisecond

			if delay > time.Second {
				delay = time.Second
			}

			timer := time.NewTimer(delay)

			select {
			case <-ctx.Done():
				timer.Stop()

				return ctx.Err()
			case <-timer.C:
			}
		}
	}
}

var _ mgmt.TelemetryController = (*Capability)(nil)
