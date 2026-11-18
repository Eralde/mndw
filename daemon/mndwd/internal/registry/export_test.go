package registry

import (
	"log/slog"

	"mndwd/internal/state"
)

func New(store *state.Store, userDir, builtinDir string) *Registry {
	return NewWithLogger(store, userDir, builtinDir, slog.New(slog.DiscardHandler))
}
