package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"mndw.local/rrd"
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
	LoadSampler        rrd.Sampler
	TemperatureSampler rrd.Sampler
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

	mu          sync.Mutex
	enabled     bool
	collector   *rrd.Collector
	retryCancel context.CancelFunc
	retryDone   chan struct{}
	starting    bool
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

	return &Capability{config: config, load: load, temp: temp, enabled: enabled}, nil
}

func (c *Capability) Start(ctx context.Context) error {
	c.mu.Lock()

	if !c.enabled || c.collector != nil || c.starting {
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

	if err := c.load.Ensure(ctx, c.config.Now().UTC()); err != nil {
		return err
	}

	if err := c.temp.Ensure(ctx, c.config.Now().UTC()); err != nil {
		return err
	}

	if _, err := c.load.LastUpdate(ctx); err != nil && !errors.Is(err, rrd.ErrFileMissing) {
		return err
	}

	if _, err := c.temp.LastUpdate(ctx); err != nil && !errors.Is(err, rrd.ErrFileMissing) {
		return err
	}

	collector := rrd.NewCollector(c.config.Executor,
		rrd.WithCollectorClock(c.config.Now),
		rrd.WithWaiter(c.config.Wait),
		rrd.WithCollectorObserver(func(file string, err error) {
			c.config.Logger.Warn("telemetry collection degraded", "file", file, "error", err)
		}),
	)

	if c.config.LoadSampler != nil {
		if err := collector.Add(&rrd.Series{
			File: filepath.Join(c.config.RRDDir, loadFileName),
			Step: 3 * time.Minute,
			DS:   loadSpec().DS,
			Tiers: []rrd.Tier{
				{Every: 3 * time.Minute, Keep: 24 * time.Hour},
				{Every: time.Hour, Keep: 30 * 24 * time.Hour},
			},
			Sample: c.config.LoadSampler,
		}); err != nil {
			return err
		}
	}

	if c.config.TemperatureSampler != nil {
		if err := collector.Add(&rrd.Series{
			File: filepath.Join(c.config.RRDDir, tempFileName),
			Step: 3 * time.Minute,
			DS:   tempSpec().DS,
			Tiers: []rrd.Tier{
				{Every: 3 * time.Minute, Keep: 24 * time.Hour},
				{Every: time.Hour, Keep: 30 * 24 * time.Hour},
			},
			Sample: c.config.TemperatureSampler,
		}); err != nil {
			return err
		}
	}

	c.mu.Lock()

	if !c.enabled {
		c.mu.Unlock()

		return nil
	}

	c.collector = collector

	c.mu.Unlock()

	go func() {
		if err := collector.Run(c.config.Lifetime); err != nil {
			c.config.Logger.Warn("telemetry collector stopped", "error", err)
		}
	}()

	return nil
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

		return c.stopCollector(ctx)
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

	return c.stopCollector(ctx)
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

func (c *Capability) stopCollector(ctx context.Context) error {
	c.mu.Lock()

	collector := c.collector
	c.collector = nil

	c.mu.Unlock()

	if collector == nil {
		return nil
	}

	return collector.Stop(ctx)
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
