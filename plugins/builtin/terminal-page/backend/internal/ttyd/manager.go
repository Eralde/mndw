package ttyd

import (
	"context"
	"errors"
	"sync"
	"time"
)

const (
	// GracePeriod is how long a console's ttyd stays alive after its last
	// proxied client disconnects. A new connection cancels the timer.
	GracePeriod = 30 * time.Second
	// SpawnIdleTimeout stops a ttyd that was spawned but never received a
	// client connection.
	SpawnIdleTimeout = 60 * time.Second
)

var errManagerClosed = errors.New("ttyd manager is closed")

// Timer is the subset of time.Timer the manager needs. Tests inject a fake
// implementation so lifecycle decisions can be asserted without sleeping.
type Timer interface {
	Stop() bool
}

// ManagerOptions injects test seams and, for the server tests, an address
// override. Zero values keep the production behavior.
type ManagerOptions struct {
	AfterFunc func(time.Duration, func()) Timer
	Address   func(Console) string
}

type consoleState struct {
	process     *Process
	connections int
	timer       Timer
	generation  uint64
	stopping    chan struct{}
}

// Manager owns one Process per console and tracks how many proxied client
// connections each console currently has. Lifecycle follows those counts:
// a console with no clients is stopped after GracePeriod, and one spawned
// without any client is stopped after SpawnIdleTimeout.
type Manager struct {
	getenv           func(string) string
	mu               sync.Mutex
	closed           bool
	consoles         map[Console]*consoleState
	afterFunc        func(time.Duration, func()) Timer
	address          func(Console) string
	gracePeriod      time.Duration
	spawnIdleTimeout time.Duration
}

func NewManager(getenv func(string) string, options ...ManagerOptions) *Manager {
	settings := ManagerOptions{}

	if len(options) > 0 {
		settings = options[0]
	}

	afterFunc := settings.AfterFunc

	if afterFunc == nil {
		afterFunc = func(duration time.Duration, callback func()) Timer {
			return time.AfterFunc(duration, callback)
		}
	}

	address := settings.Address

	if address == nil {
		address = func(console Console) string { return console.Address() }
	}

	return &Manager{
		getenv:           getenv,
		consoles:         make(map[Console]*consoleState),
		afterFunc:        afterFunc,
		address:          address,
		gracePeriod:      GracePeriod,
		spawnIdleTimeout: SpawnIdleTimeout,
	}
}

// Port returns the loopback address for a console regardless of whether its
// ttyd process is running.
func (manager *Manager) Port(console Console) string { return manager.address(console) }

// Start launches the console's own ttyd process. A running process is reused;
// other consoles are never stopped. A start waits for an in-flight stop of the
// same console, so a stale timer can never tear down a new process.
func (manager *Manager) Start(ctx context.Context, console Console) error {
	for {
		manager.mu.Lock()

		if manager.closed {
			manager.mu.Unlock()

			return errManagerClosed
		}

		state := manager.stateLocked(console)

		if state.stopping != nil {
			stopping := state.stopping

			manager.mu.Unlock()

			select {
			case <-stopping:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		err := state.process.Start(ctx)
		if err == nil {
			manager.scheduleStopLocked(console, state, manager.spawnIdleTimeout)
		}

		manager.mu.Unlock()

		return err
	}
}

// Acquire registers a live proxied connection. It returns false when the
// console has no running ttyd, so callers never count a dead session.
func (manager *Manager) Acquire(console Console) bool {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	state, ok := manager.consoles[console]
	if !ok || manager.closed || state.stopping != nil || !state.process.Running() {
		return false
	}

	state.connections++
	manager.cancelTimerLocked(state)

	return true
}

// Release removes a live proxied connection. Losing the last one starts the
// grace timer; a later Acquire cancels it.
func (manager *Manager) Release(console Console) {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	state, ok := manager.consoles[console]
	if !ok || state.connections == 0 {
		return
	}

	state.connections--

	if manager.closed || state.stopping != nil {
		return
	}

	if state.connections == 0 && state.process.Running() {
		manager.scheduleStopLocked(console, state, manager.gracePeriod)
	}
}

// StopIfIdle stops a console only when no proxied client is connected. It
// returns true when it actually stopped a running process.
func (manager *Manager) StopIfIdle(console Console) bool {
	manager.mu.Lock()

	state, ok := manager.consoles[console]
	if !ok || manager.closed || state.connections > 0 || state.stopping != nil {
		manager.mu.Unlock()

		return false
	}

	manager.cancelTimerLocked(state)

	if !state.process.Running() {
		manager.mu.Unlock()

		return false
	}

	state.stopping = make(chan struct{})
	process := state.process

	manager.mu.Unlock()

	_ = process.Stop(context.Background())

	manager.mu.Lock()
	close(state.stopping)
	state.stopping = nil
	manager.mu.Unlock()

	return true
}

// Running reports whether the console's ttyd process is alive.
func (manager *Manager) Running(console Console) bool {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	state, ok := manager.consoles[console]

	return ok && state.stopping == nil && state.process.Running()
}

// Connections reports the current number of proxied clients for a console.
func (manager *Manager) Connections(console Console) int {
	manager.mu.Lock()

	defer manager.mu.Unlock()

	state, ok := manager.consoles[console]
	if !ok {
		return 0
	}

	return state.connections
}

// Shutdown stops every timer and every ttyd process. No console can be
// restarted afterwards.
func (manager *Manager) Shutdown(ctx context.Context) error {
	manager.mu.Lock()

	manager.closed = true

	processes := make([]*Process, 0, len(manager.consoles))
	stopping := make([]chan struct{}, 0)

	for _, state := range manager.consoles {
		manager.cancelTimerLocked(state)

		if state.stopping != nil {
			stopping = append(stopping, state.stopping)

			continue
		}

		if state.process.Running() {
			processes = append(processes, state.process)
		}
	}

	manager.mu.Unlock()

	var firstErr error

	for _, process := range processes {
		if err := process.Stop(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	for _, done := range stopping {
		<-done
	}

	return firstErr
}

func (manager *Manager) stateLocked(console Console) *consoleState {
	state, ok := manager.consoles[console]
	if !ok {
		state = &consoleState{process: New(manager.getenv, console)}
		manager.consoles[console] = state
	}

	return state
}

func (manager *Manager) scheduleStopLocked(console Console, state *consoleState, delay time.Duration) {
	manager.cancelTimerLocked(state)

	if manager.closed || state.stopping != nil || state.connections > 0 {
		return
	}

	generation := state.generation

	state.timer = manager.afterFunc(delay, func() {
		manager.stopWhenIdle(console, generation)
	})
}

func (manager *Manager) cancelTimerLocked(state *consoleState) {
	// Every cancel creates a new generation so a callback that already fired
	// and is waiting on the mutex becomes stale.
	state.generation++

	if state.timer == nil {
		return
	}

	state.timer.Stop()
	state.timer = nil
}

func (manager *Manager) stopWhenIdle(console Console, generation uint64) {
	manager.mu.Lock()

	if manager.closed {
		manager.mu.Unlock()

		return
	}

	state, ok := manager.consoles[console]
	if !ok || state.generation != generation {
		manager.mu.Unlock()

		return
	}

	state.timer = nil

	if state.stopping != nil || state.connections > 0 || !state.process.Running() {
		manager.mu.Unlock()

		return
	}

	state.stopping = make(chan struct{})
	process := state.process

	manager.mu.Unlock()

	_ = process.Stop(context.Background())

	manager.mu.Lock()
	close(state.stopping)
	state.stopping = nil
	manager.mu.Unlock()
}
