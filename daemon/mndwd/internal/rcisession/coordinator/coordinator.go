// Package coordinator keeps the persistent-RCI session subsystem converged:
// it reconciles per-plugin sockets with the encrypted credential state,
// enumerates and establishes member sessions, heartbeats them, and publishes the
// activation snapshot that gates persistent-RCI plugins.
package coordinator

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"mndwd/internal/rcisession"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/establisher"
	"mndwd/internal/rcisession/heartbeat"
	"mndwd/internal/rcisession/sessionmanager"
	rcisessionsocket "mndwd/internal/rcisession/socket"
	"mndwd/internal/rcisession/status"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// DefaultHeartbeatInterval applies when Config.HeartbeatInterval is zero.
const DefaultHeartbeatInterval = 60 * time.Second

const (
	listDeadline     = 20 * time.Second
	establishTimeout = 15 * time.Second
	establishWorkers = 4
	heartbeatWorkers = 16
)

// Config wires a Coordinator. The caller builds Service, Enumerator, Manager,
// and Reconciler because the session HTTP handler and proxy share them.
type Config struct {
	Registry          *registry.Registry
	Store             *state.Store
	RuntimeRoot       string
	Service           *rcisession.Service
	Enumerator        *enumeration.Cache
	Manager           *sessionmanager.Manager
	Establisher       establisher.Establisher
	Heartbeat         heartbeat.Probe
	Reconciler        *rcisessionsocket.Reconciler
	HeartbeatInterval time.Duration
	Logger            *slog.Logger
	// Lifetime bounds the reconcile loop and establishment workers, and Close
	// calls Cancel. Set both (Cancel must cancel Lifetime) or neither; when both
	// are nil, New creates its own cancellable context.
	Lifetime context.Context
	Cancel   context.CancelFunc
}

// Coordinator owns the persistent-RCI socket bindings and their reconciliation
// with the encrypted credential state.
type Coordinator struct {
	registry        *registry.Registry
	store           *state.Store
	runtimeRoot     string
	service         *rcisession.Service
	enumerator      *enumeration.Cache
	manager         *sessionmanager.Manager
	establisher     establisher.Establisher
	heartbeat       heartbeat.Probe
	lifetime        context.Context
	cancel          context.CancelFunc
	tickDone        chan struct{}
	poke            chan struct{}
	activeCancel    context.CancelFunc
	establishSem    chan struct{}
	heartbeatEvery  time.Duration
	reconciler      *rcisessionsocket.Reconciler
	logger          *slog.Logger
	activation      atomic.Pointer[activationSnapshot]
	activationPoke  func()
	mu              sync.Mutex
	establishmentWG sync.WaitGroup
}

// New validates cfg and builds a Coordinator. See Config for the Lifetime and
// Cancel pairing rule.
func New(cfg Config) (*Coordinator, error) {
	if (cfg.Lifetime == nil) != (cfg.Cancel == nil) {
		return nil, errors.New("coordinator: Lifetime and Cancel must be set together")
	}

	interval := cfg.HeartbeatInterval

	if interval <= 0 {
		interval = DefaultHeartbeatInterval
	}

	lifetime, cancel := cfg.Lifetime, cfg.Cancel

	if lifetime == nil {
		lifetime, cancel = context.WithCancel(context.Background())
	}

	return &Coordinator{
		registry:       cfg.Registry,
		store:          cfg.Store,
		runtimeRoot:    cfg.RuntimeRoot,
		service:        cfg.Service,
		enumerator:     cfg.Enumerator,
		manager:        cfg.Manager,
		establisher:    cfg.Establisher,
		heartbeat:      cfg.Heartbeat,
		lifetime:       lifetime,
		cancel:         cancel,
		poke:           make(chan struct{}, 1),
		establishSem:   make(chan struct{}, establishWorkers),
		heartbeatEvery: interval,
		reconciler:     cfg.Reconciler,
		logger:         cfg.Logger,
	}, nil
}

// Service returns the session service this coordinator reconciles against.
func (c *Coordinator) Service() *rcisession.Service {
	return c.service
}

// Start launches the reconcile loop and requests an immediate tick. Call it once.
func (c *Coordinator) Start() {
	c.tickDone = make(chan struct{})

	go c.loop()

	c.Poke()
}
func (c *Coordinator) loop() {
	defer close(c.tickDone)

	ticker := time.NewTicker(c.heartbeatEvery)

	defer ticker.Stop()

	for {
		select {
		case <-c.lifetime.Done():
			return
		case <-ticker.C:
			c.tick()
		case <-c.poke:
			c.tick()
		}
	}
}

func (c *Coordinator) Poke() {
	if c == nil || c.enumerator == nil {
		return
	}

	c.mu.Lock()

	if c.activeCancel != nil {
		c.activeCancel()
	}

	select {
	case c.poke <- struct{}{}:
	default:
	}

	c.mu.Unlock()
	c.enumerator.Invalidate()
}

func (c *Coordinator) tick() {
	tickContext, cancel := context.WithCancel(c.lifetime)

	c.mu.Lock()

	c.activeCancel = cancel

	c.mu.Unlock()
	c.reconcileSessions(tickContext)
	cancel()
	c.mu.Lock()

	c.activeCancel = nil

	c.mu.Unlock()
}

func (c *Coordinator) reconcileSessions(ctx context.Context) {
	controller := c.service.CaptureController()

	if controller.Token != "" {
		listContext, cancel := context.WithTimeout(ctx, listDeadline)
		members, err := c.enumerator.List(listContext)

		cancel()

		if err == nil && ctx.Err() == nil && c.service.ControllerEpoch() == controller.Epoch {
			c.manager.ApplyEnumeration(members)
			c.startEstablishments(ctx, members)
		} else if err != nil {
			var controllerError enumeration.ControllerHTTPError

			if errors.As(err, &controllerError) {
				c.service.InvalidateController(controllerError.Epoch)
			}
		}
	}

	if ctx.Err() != nil {
		return
	}

	targets := c.manager.LiveHeartbeatTargets()

	heartbeat.RunBounded(ctx, targets, heartbeatWorkers, c.heartbeat, func(target heartbeat.Target, result heartbeat.Result) {
		c.manager.CommitHeartbeat(target.Identity, target.Generation, result)

		if result.Unauthorized {
			c.Poke()
		}
	})
}

func (c *Coordinator) startEstablishments(parent context.Context, members []enumeration.Member) {
	tickEpoch := c.manager.Epoch()

	for _, member := range members {
		if parent.Err() != nil {
			return
		}

		establishContext, epoch, ok := c.manager.BeginEstablishment(member.Identity, tickEpoch)

		if !ok {
			continue
		}

		generation := c.manager.Snapshot().Member(member.Identity).Generation

		c.establishmentWG.Add(1)

		go func(member enumeration.Member, establishContext context.Context, epoch, generation uint64) {
			defer c.establishmentWG.Done()

			select {
			case c.establishSem <- struct{}{}:
			case <-establishContext.Done():
				return
			case <-c.lifetime.Done():
				return
			}

			defer func() { <-c.establishSem }()

			boundedContext, cancel := context.WithTimeout(establishContext, establishTimeout)
			result, err := c.establisher.Establish(boundedContext, member)

			cancel()

			if err == nil {
				c.manager.CommitEstablishment(member.Identity, epoch, generation, sessionmanager.Candidate{BaseURL: result.BaseURL, Jar: result.Jar, Client: result.Client})

				return
			}

			var establishError establisher.EstablishError

			if errors.As(err, &establishError) && establishError.Kind == "stale" {
				return
			}

			if errors.As(err, &establishError) && establishError.Kind == "unauthorized" {
				c.service.InvalidateController(establishError.Epoch)

				return
			}

			c.manager.FailEstablishment(member.Identity, epoch, establishmentCategory(err), false)
		}(member, establishContext, epoch, generation)
	}
}

func establishmentCategory(err error) status.Category {
	var establishError establisher.EstablishError

	if errors.As(err, &establishError) {
		switch establishError.Kind {
		case "validation":
			return status.Validation
		case "malformed-response":
			return status.MalformedResponse
		case "redemption-failed":
			return status.RedemptionFailed
		case "controller-unavailable":
			return status.ControllerUnavailable
		}
	}

	return status.Transient
}

func (c *Coordinator) Close() {
	if c.cancel != nil {
		c.cancel()
	}

	if c.manager != nil {
		c.manager.DiscardAll()
	}

	if c.tickDone != nil {
		<-c.tickDone
	}

	c.establishmentWG.Wait()
	c.mu.Lock()

	if c.reconciler != nil {
		c.reconciler.Close()
	}

	c.mu.Unlock()
}
