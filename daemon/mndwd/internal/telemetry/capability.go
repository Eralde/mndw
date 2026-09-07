package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

const (
	loadFileName = "mndw-load-v1.rrd"
	tempFileName = "mndw-temp-v1.rrd"
)

type SnapshotReader interface {
	FetchGroup(context.Context, []rrd.FetchRequest) ([]rrd.FetchResult, error)
}

type CapabilityConfig struct {
	RRDToolBinary      string
	RRDDir             string
	Executor           rrd.Executor
	LoadSampler        Sampler
	TemperatureSampler Sampler
	Clock              BootClock
	Evidence           EvidenceSource
	Policy             Policy
	FileSystem         journal.FileSystem
	Locker             journal.Locker
	SnapshotCache      *SnapshotCache
	Now                func() time.Time
	Wait               func(context.Context, time.Duration) error
	DesiredEnabled     func() bool
	Logger             *slog.Logger
	RetryBackoff       []time.Duration
	Lifetime           context.Context
}

type Capability struct {
	config CapabilityConfig
	load   *rrd.File
	temp   *rrd.File

	mu           sync.Mutex
	enabled      bool
	provider     journal.StorageProvider
	pipeline     *Pipeline
	derived      *DerivedStore
	refresher    *snapshotRefresher
	pipelineDone chan struct{}
	status       PipelineStatus
	retryCancel  context.CancelFunc
	retryDone    chan struct{}
	starting     bool
}

func NewCapability(config CapabilityConfig) (*Capability, error) {
	if config.Executor == nil {
		if config.RRDToolBinary == "" {
			config.RRDToolBinary = "/opt/bin/rrdtool"
		}

		config.Executor = rrd.NewExecutor(config.RRDToolBinary)
	}

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
		config.Clock = NewBootClock()
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

	load, err := rrd.NewFile(config.Executor, filepath.Join(config.RRDDir, loadFileName), loadSpec())
	if err != nil {
		return nil, err
	}

	temp, err := rrd.NewFile(config.Executor, filepath.Join(config.RRDDir, tempFileName), tempSpec())
	if err != nil {
		return nil, err
	}

	paths, err := journal.PathsFromRRDDir(config.RRDDir)
	if err != nil {
		return nil, err
	}

	provider, err := journal.NewStorageProvider(paths, config.FileSystem, config.Locker, config.Policy.Journal)
	if err != nil {
		return nil, err
	}

	capability := &Capability{config: config, load: load, temp: temp, enabled: enabled, provider: provider}
	capability.status = PipelineStatus{Storage: provider.CurrentStatus()}
	return capability, nil
}

func (c *Capability) Start(ctx context.Context) error {
	c.mu.Lock()

	if !c.enabled || c.pipeline != nil || c.starting {
		c.mu.Unlock()

		return nil
	}

	c.starting = true

	c.mu.Unlock()

	defer func() {
		c.mu.Lock()

		c.starting = false

		c.mu.Unlock()
	}()

	// Storage is opened before any derived RRD work so acquired records are
	// durable first; a failed open keeps diagnostics and the bounded RAM queue.
	opened, err := c.provider.Reopen(ctx)
	if err != nil {
		c.setStatusError(err)

		if opened.Status.Mode == journal.StatusUnavailable {
			return err
		}
	}
	c.mu.Lock()
	c.status.Storage = opened.Status
	c.mu.Unlock()

	// Derived files are validated, never created here: an untrusted boot must
	// not create an RRD, and creation is owned by derived recovery once this
	// boot has trustworthy time.
	if err := c.validateDerivedFiles(ctx); err != nil {
		c.config.Logger.Warn("telemetry derived files unavailable", "error", err)
	}

	samplers := map[uint16]Sampler{}
	if c.config.LoadSampler != nil {
		samplers[1] = c.config.LoadSampler
	}
	if c.config.TemperatureSampler != nil {
		samplers[2] = c.config.TemperatureSampler
	}
	if len(samplers) == 0 {
		return errors.New("telemetry: no sampler configured")
	}

	if c.config.SnapshotCache != nil {
		c.config.SnapshotCache.SetSupportedSeries(supportedFromSamplers(samplers))
	}

	derivedPaths, err := journal.PathsFromRRDDir(c.config.RRDDir)
	if err != nil {
		return err
	}

	derived, err := NewDerivedStore(derivedPaths, RRDtoolFactory{Executor: c.config.Executor}, c.provider, c.config.FileSystem)
	if err != nil {
		return err
	}

	options := []PipelineOption{WithPublicationWorker(derived)}
	if c.config.SnapshotCache != nil {
		refresher := &snapshotRefresher{cache: c.config.SnapshotCache}
		options = append(options, WithSnapshotRefresher(refresher))
		c.mu.Lock()
		c.refresher = refresher
		c.mu.Unlock()
	}

	pipeline, err := NewPipeline(c.config.Policy, c.config.Clock, c.config.Evidence, c.provider, samplers, options...)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.derived = derived
	c.mu.Unlock()

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

// validateDerivedFiles checks existing RRD files without creating any. An
// absent file is left to derived recovery, which creates it only from retained
// mapped records with trustworthy time.
func (c *Capability) validateDerivedFiles(ctx context.Context) error {
	for _, file := range []*rrd.File{c.load, c.temp} {
		if _, err := file.LastUpdate(ctx); err == nil {
			continue
		} else if !errors.Is(err, rrd.ErrFileMissing) {
			return err
		}
	}
	return nil
}

// SessionReader exposes bounded diagnostic session access. It serves read-only
// validated records and never repairs or writes storage.
func (c *Capability) SessionReader() SessionReader {
	c.mu.Lock()
	provider := c.provider
	policy := c.config.Policy
	c.mu.Unlock()

	if provider == nil {
		return nil
	}
	return NewSessionReader(provider, c.Status, policy.Journal)
}

// SetSnapshotCache attaches the cache refreshed by the pipeline. It is called
// after construction because assembly builds the cache from this capability.
func (c *Capability) SetSnapshotCache(cache *SnapshotCache) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.config.SnapshotCache = cache
}

// Status reports the last observed pipeline and storage state.
func (c *Capability) Status() PipelineStatus {
	c.mu.Lock()
	defer c.mu.Unlock()

	status := c.status
	if c.pipeline != nil {
		status = c.pipeline.Status()
	}
	if c.derived != nil {
		frontiers := c.derived.Progress()
		if len(frontiers) > 0 {
			status.Frontiers = frontiers
		}
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

			return nil
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
	refresher := c.refresher
	c.refresher = nil
	c.mu.Unlock()

	if refresher != nil {
		if err := refresher.Close(ctx); err != nil {
			return err
		}
	}

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

func (c *Capability) LoadReader() SnapshotReader {
	return c.load
}

func (c *Capability) TemperatureReader() SnapshotReader {
	return c.temp
}

func loadSpec() rrd.CreateSpec {
	return rrd.CreateSpec{
		Step: 3 * time.Minute,
		DS: []rrd.DSSpec{
			{Name: "cpu", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(0), Max: floatPtr(100)},
			{Name: "ram", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(0), Max: floatPtr(100)},
		},
		RRA: tierRRAs(),
	}
}

func tempSpec() rrd.CreateSpec {
	return rrd.CreateSpec{
		Step: 3 * time.Minute,
		DS: []rrd.DSSpec{
			{Name: "value", Type: "GAUGE", Heartbeat: 390 * time.Second, Min: floatPtr(-100000), Max: floatPtr(250000)},
		},
		RRA: tierRRAs(),
	}
}

func tierRRAs() []rrd.RRASpec {
	result := make([]rrd.RRASpec, 0, 6)

	for _, stepsRows := range []struct{ steps, rows int }{{1, 480}, {20, 720}} {
		for _, cf := range []string{"AVERAGE", "MIN", "MAX"} {
			result = append(result, rrd.RRASpec{CF: cf, XFF: 0.5, Steps: stepsRows.steps, Rows: stepsRows.rows})
		}
	}

	return result
}

func floatPtr(value float64) *float64 {
	return &value
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
