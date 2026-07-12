// Package lifecycle runs a plugin's backend.daemon start/stop hooks (design §5.2).
// The hooks are ordinary sh scripts: `start` launches the long-running process (it is
// responsible for backgrounding itself and recording its own pid, as v1's ttyd
// spawn did) and returns; `stop` tears it down. The daemon invokes these on
// approve/enable (start), disable/delete (stop), and at boot for every approved +
// enabled plugin that declares them. lifecycle holds no process handles itself — the
// scripts own their process state — so it stays correct across a daemon restart.
package lifecycle

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// hookTimeout bounds how long a start/stop hook may run. Hooks should return promptly
// after (un)launching the background process.
const hookTimeout = 30 * time.Second

// outputTailBytes bounds how much hook output is kept for logging.
const outputTailBytes = 4 << 10

// Manager runs daemon hooks.
type Manager struct {
	logger *slog.Logger
}

// New constructs a lifecycle Manager.
func New(logger *slog.Logger) *Manager {
	return &Manager{logger: logger}
}

// Start runs the plugin's backend.daemon.start hook. It is a no-op when the plugin
// declares no daemon.
func (m *Manager) Start(name, dir, start string) error {
	return m.runHook(name, dir, start, "start")
}

// Stop runs the plugin's backend.daemon.stop hook. It is a no-op when the plugin
// declares no daemon.
func (m *Manager) Stop(name, dir, stop string) error {
	return m.runHook(name, dir, stop, "stop")
}

func (m *Manager) runHook(name, dir, rel, which string) error {
	if rel == "" {
		return nil
	}

	scriptPath, err := safeJoin(dir, rel)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), hookTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, scriptPath)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "MNDW_PLUGIN_ID="+name)

	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out

	if err := cmd.Run(); err != nil {
		m.logger.Error("daemon hook failed", "plugin", name, "hook", which, "output", tail(out.String()))

		return fmt.Errorf("daemon %s hook for %s: %w", which, name, err)
	}

	m.logger.Info("daemon hook ran", "plugin", name, "hook", which)

	return nil
}

// safeJoin joins rel onto dir and rejects any result that escapes dir. Manifest
// schema already guarantees rel is a safe relative path; this is defense in depth
// before exec.
func safeJoin(dir, rel string) (string, error) {
	joined := filepath.Join(dir, rel)
	if joined != dir && !strings.HasPrefix(joined, dir+string(os.PathSeparator)) {
		return "", fmt.Errorf("daemon hook path escapes plugin dir: %q", rel)
	}

	return joined, nil
}

func tail(s string) string {
	if len(s) <= outputTailBytes {
		return s
	}

	return s[len(s)-outputTailBytes:]
}
