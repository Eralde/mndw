package rrd

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Sampler interface {
	Poll(context.Context) ([]Value, error)
}

type Series struct {
	File   string
	Step   time.Duration
	DS     []DSSpec
	Tiers  []Tier
	Sample Sampler
}

type CollectorOption func(*collectorConfig)

type collectorConfig struct {
	clock          func() time.Time
	waiter         func(context.Context, time.Duration) error
	flushAge       time.Duration
	bufferCapacity int
	observer       func(string, error)
}

type Collector struct {
	executor Executor
	config   collectorConfig

	mu      sync.Mutex
	series  map[string]*collectorSeries
	cancel  context.CancelFunc
	running bool
	wg      sync.WaitGroup
}

type collectorSeries struct {
	file       *File
	sample     Sampler
	step       time.Duration
	dsCount    int
	flushAge   time.Duration
	capacity   int
	observer   func(string, error)
	buffer     []UpdatePoint
	lastSample time.Time
}

func NewCollector(executor Executor, opts ...CollectorOption) *Collector {
	config := collectorConfig{
		clock:          time.Now,
		waiter:         waitContext,
		flushAge:       15 * time.Minute,
		bufferCapacity: 5,
	}

	for _, opt := range opts {
		if opt != nil {
			opt(&config)
		}
	}

	if config.clock == nil {
		config.clock = time.Now
	}

	if config.waiter == nil {
		config.waiter = waitContext
	}

	if config.flushAge <= 0 {
		config.flushAge = 15 * time.Minute
	}

	if config.bufferCapacity <= 0 {
		config.bufferCapacity = 5
	}

	return &Collector{executor: executor, config: config, series: make(map[string]*collectorSeries)}
}

func WithCollectorClock(clock func() time.Time) CollectorOption {
	return func(config *collectorConfig) {
		config.clock = clock
	}
}

func WithWaiter(waiter func(context.Context, time.Duration) error) CollectorOption {
	return func(config *collectorConfig) {
		config.waiter = waiter
	}
}

func WithFlushAge(age time.Duration) CollectorOption {
	return func(config *collectorConfig) {
		config.flushAge = age
	}
}

func WithBufferCapacity(capacity int) CollectorOption {
	return func(config *collectorConfig) {
		config.bufferCapacity = capacity
	}
}

func WithCollectorObserver(observer func(string, error)) CollectorOption {
	return func(config *collectorConfig) {
		config.observer = observer
	}
}

func (c *Collector) Add(series *Series) error {
	if series == nil || series.Sample == nil {
		return errors.New("rrd: series sampler is required")
	}

	if series.File == "" || series.Step <= 0 || series.Step%time.Second != 0 {
		return errors.New("rrd: series file and positive whole-second step are required")
	}

	if len(series.DS) == 0 || len(series.Tiers) == 0 {
		return errors.New("rrd: series data sources and tiers are required")
	}

	spec := CreateSpec{Step: series.Step, DS: append([]DSSpec(nil), series.DS...)}

	for _, tier := range series.Tiers {
		if tier.Every <= 0 || tier.Keep <= 0 || tier.Every%series.Step != 0 || tier.Keep%tier.Every != 0 {
			return errors.New("rrd: invalid series tier")
		}

		steps := int(tier.Every / series.Step)
		rows := int(tier.Keep / tier.Every)

		for _, cf := range []string{"AVERAGE", "MIN", "MAX"} {
			spec.RRA = append(spec.RRA, RRASpec{CF: cf, XFF: 0.5, Steps: steps, Rows: rows})
		}
	}

	file, err := NewFile(c.executor, series.File, spec)
	if err != nil {
		return err
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	if _, exists := c.series[file.path]; exists {
		return fmt.Errorf("rrd: series already registered for %s", file.path)
	}

	c.series[file.path] = &collectorSeries{
		file:     file,
		sample:   series.Sample,
		step:     series.Step,
		dsCount:  len(series.DS),
		flushAge: c.config.flushAge,
		capacity: c.config.bufferCapacity,
		observer: c.config.observer,
	}

	return nil
}

func (c *Collector) Run(ctx context.Context) error {
	c.mu.Lock()

	if c.running {
		c.mu.Unlock()

		return errors.New("rrd: collector already running")
	}

	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.running = true
	series := make([]*collectorSeries, 0, len(c.series))

	for _, item := range c.series {
		series = append(series, item)
	}

	c.wg.Add(len(series))
	c.mu.Unlock()

	for _, item := range series {
		go c.runSeries(runCtx, item)
	}

	<-runCtx.Done()
	c.wg.Wait()
	c.mu.Lock()

	c.running = false
	c.cancel = nil

	c.mu.Unlock()

	return nil
}

func (c *Collector) Stop(ctx context.Context) error {
	c.mu.Lock()

	cancel := c.cancel
	running := c.running
	series := make([]*collectorSeries, 0, len(c.series))

	for _, item := range c.series {
		series = append(series, item)
	}

	c.mu.Unlock()

	if running && cancel != nil {
		cancel()
		c.wg.Wait()
	}

	var firstErr error

	for _, item := range series {
		if err := item.flush(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	return firstErr
}

func (c *Collector) runSeries(ctx context.Context, series *collectorSeries) {
	defer c.wg.Done()

	for {
		if len(series.buffer) > 0 {
			if err := series.flush(ctx); err != nil {
				series.report(err)
			}

			if err := c.config.waiter(ctx, series.step); err != nil {
				return
			}

			continue
		}

		if err := series.pollAndMaybeFlush(ctx, c.config.clock()); err != nil {
			series.report(err)
		}

		if err := c.config.waiter(ctx, series.step); err != nil {
			return
		}
	}
}

func (s *collectorSeries) pollAndMaybeFlush(ctx context.Context, now time.Time) error {
	values, err := s.sample.Poll(ctx)

	if values == nil {
		values = make([]Value, s.dsCount)
	}

	if len(values) > s.dsCount {
		values = make([]Value, s.dsCount)
		err = errors.Join(err, errors.New("rrd: sampler returned too many values"))
	} else if len(values) < s.dsCount {
		padded := make([]Value, s.dsCount)

		copy(padded, values)

		values = padded
	}

	timestamp := now.UTC().Truncate(s.step)

	if !s.lastSample.IsZero() && !timestamp.After(s.lastSample) {
		return errors.Join(err, ErrChronology)
	}

	s.lastSample = timestamp
	s.buffer = append(s.buffer, UpdatePoint{Timestamp: timestamp, Values: values})

	if len(s.buffer) >= s.capacity || timestamp.Sub(s.buffer[0].Timestamp) >= s.flushAge {
		return errors.Join(err, s.flush(ctx))
	}

	return err
}

func (s *collectorSeries) flush(ctx context.Context) error {
	if len(s.buffer) == 0 {
		return nil
	}

	pending := append([]UpdatePoint(nil), s.buffer...)

	if err := s.file.Update(ctx, pending); err == nil {
		s.buffer = nil

		return nil
	}

	last, lastErr := s.file.LastUpdate(ctx)

	if lastErr == nil {
		remaining := pending[:0]

		for _, point := range pending {
			if point.Timestamp.After(last) {
				remaining = append(remaining, point)
			}
		}

		if len(remaining) == 0 {
			s.buffer = nil

			return nil
		}

		if err := s.file.Update(ctx, remaining); err == nil {
			s.buffer = nil

			return nil
		}
	}

	return errors.New("rrd: telemetry flush failed")
}

func (s *collectorSeries) report(err error) {
	if s.observer != nil {
		s.observer(s.file.path, err)
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
