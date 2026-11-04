package opkg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	ErrBusy     = errors.New("opkg busy")
	ErrNoUpdate = errors.New("no mndw update available")
)

type SelfUpdateCandidate struct {
	CurrentVersion string
	TargetVersion  string
	PackagePath    string
}

type LeaseHandle interface {
	File() *os.File
	CommitHandoff() error
	Abort() error
}

type SelfUpdateManager interface {
	Manager
	CheckSelfUpdate(context.Context) (SelfUpdateCandidate, error)
	PrepareSelfUpdate(context.Context) (SelfUpdateCandidate, LeaseHandle, error)
	LockForSelfUpdate(context.Context) (LeaseHandle, error)
	SelfUpdateLocked() (bool, error)
}

type Paths struct {
	StateDir   string
	PendingDir string
	LockPath   string
}

type lease struct {
	file        *os.File
	releaseGate func()
	closed      bool
}

func (l *lease) File() *os.File { return l.file }

func (l *lease) CommitHandoff() error {
	if l.closed {
		return nil
	}

	l.closed = true
	err := l.file.Close()

	l.releaseGate()

	return err
}

func (l *lease) Abort() error {
	if l.closed {
		return nil
	}

	l.closed = true
	unlockErr := unlockFile(l.file)
	closeErr := l.file.Close()

	l.releaseGate()

	if unlockErr != nil {
		return unlockErr
	}

	return closeErr
}

func (m *execManager) acquireGate(ctx context.Context, wait bool) (func(), error) {
	m.defaults()

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	release := func() { <-m.gate }

	if !wait {
		select {
		case m.gate <- struct{}{}:
			return release, nil
		default:
			return nil, ErrBusy
		}
	}

	select {
	case m.gate <- struct{}{}:
		return release, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *execManager) acquireMutation(ctx context.Context, wait bool) (*lease, error) {
	releaseGate, err := m.acquireGate(ctx, wait)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(filepath.Dir(m.lockPath), 0o755); err != nil {
		releaseGate()

		return nil, err
	}

	file, err := os.OpenFile(m.lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		releaseGate()

		return nil, err
	}

	busy, err := tryLockExclusive(file)
	if err != nil {
		_ = file.Close()

		releaseGate()

		return nil, err
	}

	if busy {
		_ = file.Close()

		releaseGate()

		return nil, ErrBusy
	}

	return &lease{file: file, releaseGate: releaseGate}, nil
}

func (m *execManager) tryMutation(ctx context.Context) (*lease, error) {
	return m.acquireMutation(ctx, false)
}

func (m *execManager) lockForSelfUpdate(ctx context.Context) (LeaseHandle, error) {
	return m.LockForSelfUpdate(ctx)
}

func (m *execManager) LockForSelfUpdate(ctx context.Context) (LeaseHandle, error) {
	return m.tryMutation(ctx)
}

func (m *execManager) SelfUpdateLocked() (bool, error) {
	m.defaults()

	file, err := os.OpenFile(m.lockPath, os.O_RDWR, 0o644)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}

	if err != nil {
		return false, err
	}

	defer file.Close()

	busy, err := tryLockExclusive(file)
	if err != nil {
		return false, err
	}

	if busy {
		return true, nil
	}

	if err := unlockFile(file); err != nil {
		return false, err
	}

	return false, nil
}

func execRunInDir(ctx context.Context, dir string, args ...string) (string, int, error) {
	if len(args) == 0 {
		return "", 0, errors.New("opkg command is missing")
	}

	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	if ctx.Err() != nil {
		return "", 0, ctx.Err()
	}

	if err == nil {
		return stdout.String(), 0, nil
	}

	if errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err) {
		return "", 0, fmt.Errorf("%w: %v", ErrOpkgUnavailable, err)
	}

	var exitErr *exec.ExitError

	if errors.As(err, &exitErr) {
		return stdout.String() + stderr.String(), exitErr.ExitCode(), nil
	}

	return "", 0, err
}

func (m *execManager) runInDir(ctx context.Context, dir string, args ...string) (string, int, error) {
	m.defaults()

	if m.downloadRunner != nil {
		return m.downloadRunner(ctx, dir, args...)
	}

	return execRunInDir(ctx, dir, args...)
}

func parseUpgradable(out, name string) (SelfUpdateCandidate, bool, error) {
	var candidate SelfUpdateCandidate
	found := false

	for lineNumber, rawLine := range strings.Split(out, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(rawLine, "\r"))

		if line == "" || isArchitectureWarning(line) {
			continue
		}

		parts := strings.Split(line, " - ")

		if len(parts) == 0 || strings.TrimSpace(parts[0]) != name {
			if strings.HasPrefix(line, name+" ") {
				return SelfUpdateCandidate{}, false, fmt.Errorf("malformed opkg upgradable line %d: %q", lineNumber+1, line)
			}

			continue
		}

		if len(parts) != 3 {
			return SelfUpdateCandidate{}, false, fmt.Errorf("malformed opkg upgradable line %d: %q", lineNumber+1, line)
		}

		current := strings.TrimSpace(parts[1])
		target := strings.TrimSpace(parts[2])

		if current == "" || target == "" {
			return SelfUpdateCandidate{}, false, fmt.Errorf("malformed opkg upgradable line %d: %q", lineNumber+1, line)
		}

		if found {
			return SelfUpdateCandidate{}, false, fmt.Errorf("duplicate opkg upgradable entry for %s", name)
		}

		candidate = SelfUpdateCandidate{CurrentVersion: current, TargetVersion: target}
		found = true
	}

	return candidate, found, nil
}

func (m *execManager) refreshCandidateLocked(ctx context.Context) (SelfUpdateCandidate, error) {
	if out, exitCode, err := m.run(ctx, "opkg", "update"); err != nil {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg update: %w", err)
	} else if exitCode != 0 {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg update exited %d", exitCode)
	} else {
		_ = out
	}

	installedOut, exitCode, err := m.run(ctx, "opkg", "list-installed", "mndw")
	if err != nil {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg list-installed mndw: %w", err)
	}

	if exitCode != 0 {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg list-installed mndw exited %d", exitCode)
	}

	installed, err := parseEntries(installedOut)
	if err != nil {
		return SelfUpdateCandidate{}, err
	}

	var current string

	for _, entry := range installed {
		if entry.Name != "mndw" {
			continue
		}

		if current != "" {
			return SelfUpdateCandidate{}, errors.New("duplicate installed mndw entries")
		}

		current = entry.Version
	}

	if current == "" {
		return SelfUpdateCandidate{}, errors.New("mndw is not installed")
	}

	upgradableOut, exitCode, err := m.run(ctx, "opkg", "list-upgradable")
	if err != nil {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg list-upgradable: %w", err)
	}

	if exitCode != 0 {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg list-upgradable exited %d", exitCode)
	}

	candidate, found, err := parseUpgradable(upgradableOut, "mndw")
	if err != nil {
		return SelfUpdateCandidate{}, err
	}

	if !found {
		return SelfUpdateCandidate{CurrentVersion: current}, nil
	}

	if candidate.CurrentVersion != current {
		return SelfUpdateCandidate{}, fmt.Errorf("opkg candidate current version %q differs from installed version %q", candidate.CurrentVersion, current)
	}

	return candidate, nil
}

func (m *execManager) CheckSelfUpdate(ctx context.Context) (SelfUpdateCandidate, error) {
	lease, err := m.tryMutation(ctx)
	if err != nil {
		return SelfUpdateCandidate{}, err
	}

	defer lease.Abort()

	return m.refreshCandidateLocked(ctx)
}

func (m *execManager) resetPendingLocked() error {
	if err := os.RemoveAll(m.pendingDir); err != nil {
		return fmt.Errorf("clear pending update: %w", err)
	}

	if err := os.MkdirAll(m.pendingDir, 0o755); err != nil {
		return fmt.Errorf("create pending update directory: %w", err)
	}

	return nil
}

func (m *execManager) downloadCandidateLocked(ctx context.Context, target string) (string, error) {
	tempDir, err := os.MkdirTemp(m.pendingDir, ".download-")
	if err != nil {
		return "", fmt.Errorf("create download directory: %w", err)
	}

	defer os.RemoveAll(tempDir)

	if _, exitCode, err := m.runInDir(ctx, tempDir, "opkg", "download", "mndw"); err != nil {
		return "", fmt.Errorf("opkg download mndw: %w", err)
	} else if exitCode != 0 {
		return "", fmt.Errorf("opkg download mndw exited %d", exitCode)
	}

	pattern := regexp.MustCompile(`^mndw_` + regexp.QuoteMeta(target) + `_[^/]+\.ipk$`)
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return "", fmt.Errorf("read downloaded package directory: %w", err)
	}

	var source string

	for _, entry := range entries {
		if !pattern.MatchString(entry.Name()) {
			continue
		}

		if source != "" {
			return "", fmt.Errorf("multiple mndw IPKs downloaded for target %s", target)
		}

		if entry.Type()&os.ModeSymlink != 0 {
			return "", errors.New("downloaded mndw IPK is a symlink")
		}

		info, infoErr := entry.Info()

		if infoErr != nil {
			return "", fmt.Errorf("inspect downloaded mndw IPK: %w", infoErr)
		}

		if !info.Mode().IsRegular() {
			return "", errors.New("downloaded mndw IPK is not a regular file")
		}

		source = filepath.Join(tempDir, entry.Name())
	}

	if source == "" {
		return "", fmt.Errorf("no mndw IPK downloaded for target %s", target)
	}

	destination := filepath.Join(m.pendingDir, "mndw-"+target+".ipk")

	if err := os.Rename(source, destination); err != nil {
		return "", fmt.Errorf("normalize downloaded mndw IPK: %w", err)
	}

	return destination, nil
}

func (m *execManager) PrepareSelfUpdate(ctx context.Context) (SelfUpdateCandidate, LeaseHandle, error) {
	lease, err := m.tryMutation(ctx)
	if err != nil {
		return SelfUpdateCandidate{}, nil, err
	}

	if err := m.resetPendingLocked(); err != nil {
		_ = lease.Abort()

		return SelfUpdateCandidate{}, nil, err
	}

	candidate, err := m.refreshCandidateLocked(ctx)
	if err != nil {
		_ = m.resetPendingLocked()
		_ = lease.Abort()

		return SelfUpdateCandidate{}, nil, err
	}

	if candidate.TargetVersion == "" {
		_ = lease.Abort()

		return SelfUpdateCandidate{}, nil, ErrNoUpdate
	}

	candidate.PackagePath, err = m.downloadCandidateLocked(ctx, candidate.TargetVersion)
	if err != nil {
		_ = m.resetPendingLocked()
		_ = lease.Abort()

		return SelfUpdateCandidate{}, nil, err
	}

	return candidate, lease, nil
}
