package mgmt

import "mndwd/internal/state"

// StateStore is the durable plugin-state behavior required by management
// handlers. Keeping this seam narrow lets lifecycle tests exercise persistence
// failure without depending on filesystem permissions.
type StateStore interface {
	Get(string) (*state.Plugin, bool)
	Snapshot() *state.State
	Mutate(func(*state.State) error) error
}
