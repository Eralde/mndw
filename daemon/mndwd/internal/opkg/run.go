package opkg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

const tailOutputBytes = 4 << 10

func tailOutput[T ~[]byte | ~string](value T) T {
	if len(value) <= tailOutputBytes {
		return value
	}

	return value[len(value)-tailOutputBytes:]
}

// ------------------------------------
// exec implementation
// ------------------------------------

type execManager struct {
	logger         *slog.Logger
	runner         func(ctx context.Context, args ...string) (string, int, error)
	downloadRunner func(ctx context.Context, dir string, args ...string) (string, int, error)
	listsDir       string
	stateDir       string
	pendingDir     string
	lockPath       string
	// gate is a 1-slot semaphore serializing mutating operations. A plain mutex
	// would defeat cancellation: Lock() cannot be interrupted, so a shutdown
	// arriving while another install holds the lock would stall the caller for
	// the full remaining install. Acquisition selects on ctx instead.
	gate       chan struct{}
	defaultsMu sync.Mutex
}

func (m *execManager) defaults() {
	m.defaultsMu.Lock()

	defer m.defaultsMu.Unlock()

	if m.logger == nil {
		m.logger = slog.Default()
	}

	if m.listsDir == "" {
		m.listsDir = "/opt/var/opkg-lists/"
	}

	if m.stateDir == "" {
		m.stateDir = "/opt/var/mndw"
	}

	if m.pendingDir == "" {
		m.pendingDir = filepath.Join(m.stateDir, "pending")
	}

	if m.lockPath == "" {
		m.lockPath = filepath.Join(m.stateDir, "self-update.lock")
	}

	if m.gate == nil {
		m.gate = make(chan struct{}, 1)
	}
}

func execRun(ctx context.Context, args ...string) (string, int, error) {
	if len(args) == 0 {
		return "", 0, errors.New("opkg command is missing")
	}

	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	if ctx.Err() != nil {
		return "", 0, ctx.Err()
	}

	if err == nil {
		return stdout.String(), 0, nil
	}

	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return "", 0, fmt.Errorf("%w: %v", ErrOpkgUnavailable, err)
	}

	var exitErr *exec.ExitError

	if errors.As(err, &exitErr) {
		// Non-zero exit: append stderr — opkg reports its failure reason there, and
		// the callers log this output. Exit-0 output stays stdout-only, as it is
		// parsed (list/list-installed) and stderr warnings would corrupt it.
		return stdout.String() + stderr.String(), exitErr.ExitCode(), nil
	}

	return "", 0, err
}

func (m *execManager) run(ctx context.Context, args ...string) (string, int, error) {
	m.defaults()

	if m.runner != nil {
		return m.runner(ctx, args...)
	}

	return execRun(ctx, args...)
}

func (m *execManager) mutate(ctx context.Context, action string, packages []string, args ...string) error {
	_, err := m.mutateOutput(ctx, action, packages, args...)

	return err
}

// mutateOutput runs a mutating opkg command and returns its combined output. Callers
// that need to inspect the output beyond the exit code (e.g. remove, to detect the
// reverse-dependency warning opkg emits with a zero exit) use it directly.
func (m *execManager) mutateOutput(ctx context.Context, action string, packages []string, args ...string) (string, error) {
	m.defaults()

	if err := validate(packages); err != nil {
		return "", err
	}

	lease, err := m.acquireMutation(ctx, true)
	if err != nil {
		return "", fmt.Errorf("opkg %s: %w", action, err)
	}

	defer lease.Abort()

	commandArgs := append([]string{"opkg"}, args...)
	commandArgs = append(commandArgs, packages...)
	out, exitCode, err := m.run(ctx, commandArgs...)
	if err != nil {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", tailOutput(out))

		return out, fmt.Errorf("opkg %s: %w", action, err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", tailOutput(out), "exitCode", exitCode)

		// Include opkg's own output (its failure reason lives there) so the surfaced
		// error is actionable instead of an opaque exit code.
		if reason := strings.TrimSpace(tailOutput(out)); reason != "" {
			return out, fmt.Errorf("opkg %s exited %d: %s", action, exitCode, reason)
		}

		return out, fmt.Errorf("opkg %s exited %d", action, exitCode)
	}

	return out, nil
}
