package registry

import (
	"mndwd/internal/state"
)

func New(store *state.Store, userDir, builtinDir string) *Registry {
	return NewWithLogger(store, userDir, builtinDir, nil)
}
