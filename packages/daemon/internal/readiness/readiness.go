// Package readiness tracks per-plugin dependency-install state for builtins whose
// opkg dependencies install in the background after daemon startup (design: background
// builtin deps). Ready is represented by absence: entries exist only while a plugin is
// installing or has failed, so a tracker that never saw a plugin reports it ready.
package readiness

import "sync"

// State is a plugin's dependency-install state as surfaced to the management API.
type State string

const (
	// StateInstalling marks a builtin whose opkg dependencies are still being installed.
	StateInstalling State = "installing"
	// StateFailed marks a builtin whose dependency install exhausted its retries.
	StateFailed State = "failed"
)

// Tracker is a concurrency-safe map of plugin name to dependency-install state.
type Tracker struct {
	mu     sync.RWMutex
	states map[string]State
}

// New constructs an empty Tracker. The zero value is not usable.
func New() *Tracker {
	return &Tracker{states: make(map[string]State)}
}

// Set records the plugin's current state.
func (t *Tracker) Set(name string, s State) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.states[name] = s
}

// MarkReady deletes the plugin's entry — ready is absence. Unknown names are a no-op.
func (t *Tracker) MarkReady(name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.states, name)
}

// Get reports the plugin's state; ok is false when the plugin is ready (absent).
func (t *Tracker) Get(name string) (State, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s, ok := t.states[name]

	return s, ok
}
