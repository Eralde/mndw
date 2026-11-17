package opkg

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newExecManagerWithRunner(t *testing.T, runner func(context.Context, ...string) (string, int, error)) *execManager {
	t.Helper()

	stateDir := t.TempDir()

	return &execManager{
		logger:     discard(),
		runner:     runner,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
}
