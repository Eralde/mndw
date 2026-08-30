package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"mndwd/internal/opkg"
)

var (
	ErrBusy       = errors.New("self-update busy")
	ErrNoRollback = errors.New("no rollback available")
)

type PackageManager interface {
	CheckSelfUpdate(context.Context) (opkg.SelfUpdateCandidate, error)
	PrepareSelfUpdate(context.Context) (opkg.SelfUpdateCandidate, opkg.LeaseHandle, error)
	LockForSelfUpdate(context.Context) (opkg.LeaseHandle, error)
	SelfUpdateLocked() (bool, error)
}

type Service interface {
	Status() (Status, error)
	Check(context.Context) (CheckResult, error)
	BeginUpdate(context.Context) (Accepted, error)
	BeginRevert(context.Context) (Accepted, error)
}

type CheckResult struct {
	CurrentVersion    string `json:"currentVersion"`
	TargetVersion     string `json:"targetVersion,omitempty"`
	UpdateAvailable   bool   `json:"updateAvailable"`
	RollbackVersion   string `json:"rollbackVersion,omitempty"`
	RollbackAvailable bool   `json:"rollbackAvailable"`
}

type Accepted struct {
	Operation     Operation `json:"operation"`
	TargetVersion string    `json:"targetVersion"`
}

type Config struct {
	StateDir       string
	PackagedHelper string
	RunningVersion string
	Logger         *slog.Logger
}

type startProcessFunc func(script string, args []string, lockFile *os.File) error

type service struct {
	manager        PackageManager
	store          *StateStore
	stateDir       string
	packagedHelper string
	runningVersion string
	logger         *slog.Logger
	startProcess   startProcessFunc
}

func New(config Config, manager PackageManager) Service {
	if config.StateDir == "" {
		config.StateDir = "/opt/var/mndw"
	}

	if config.PackagedHelper == "" {
		config.PackagedHelper = "/opt/share/www/mndw/bin/mndw-self-update.sh"
	}

	if config.RunningVersion == "" {
		config.RunningVersion = "dev"
	}

	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	return &service{
		manager:        manager,
		store:          NewStateStore(config.StateDir),
		stateDir:       config.StateDir,
		packagedHelper: config.PackagedHelper,
		runningVersion: config.RunningVersion,
		logger:         config.Logger,
		startProcess:   startDetached,
	}
}

func (s *service) helperPath() string { return filepath.Join(s.stateDir, "self-update.sh") }

func normalizeManagerError(err error) error {
	if errors.Is(err, opkg.ErrBusy) {
		return ErrBusy
	}

	return err
}

func (s *service) Status() (Status, error) {
	locked, err := s.manager.SelfUpdateLocked()
	if err != nil {
		return Status{}, err
	}

	return s.store.Status(s.runningVersion, locked), nil
}

func (s *service) Check(ctx context.Context) (CheckResult, error) {
	candidate, err := s.manager.CheckSelfUpdate(ctx)
	if err != nil {
		return CheckResult{}, normalizeManagerError(err)
	}

	rollback := s.store.RollbackVersion(s.runningVersion)

	return CheckResult{
		CurrentVersion:    candidate.CurrentVersion,
		TargetVersion:     candidate.TargetVersion,
		UpdateAvailable:   candidate.TargetVersion != "",
		RollbackVersion:   rollback,
		RollbackAvailable: rollback != "",
	}, nil
}

func (s *service) copyHelper() error {
	info, err := os.Lstat(s.packagedHelper)
	if err != nil {
		return fmt.Errorf("inspect packaged self-update helper: %w", err)
	}

	if !info.Mode().IsRegular() {
		return errors.New("packaged self-update helper is not a regular file")
	}

	source, err := os.Open(s.packagedHelper)
	if err != nil {
		return fmt.Errorf("open packaged self-update helper: %w", err)
	}

	defer source.Close()

	if err := os.MkdirAll(s.stateDir, 0o755); err != nil {
		return fmt.Errorf("create self-update state directory: %w", err)
	}

	temp, err := os.CreateTemp(s.stateDir, ".self-update-helper-")
	if err != nil {
		return fmt.Errorf("create self-update helper temporary file: %w", err)
	}

	tempPath := temp.Name()
	keep := false

	defer func() {
		if !keep {
			_ = os.Remove(tempPath)
		}
	}()

	if err := temp.Chmod(0o755); err != nil {
		_ = temp.Close()

		return err
	}

	if _, err := io.Copy(temp, source); err != nil {
		_ = temp.Close()

		return fmt.Errorf("copy self-update helper: %w", err)
	}

	if err := temp.Sync(); err != nil {
		_ = temp.Close()

		return fmt.Errorf("sync self-update helper: %w", err)
	}

	if err := temp.Close(); err != nil {
		return fmt.Errorf("close self-update helper: %w", err)
	}

	if err := os.Rename(tempPath, s.helperPath()); err != nil {
		return fmt.Errorf("activate self-update helper: %w", err)
	}

	keep = true

	return nil
}

func (s *service) cleanupCandidate(path string) {
	if path == "" {
		return
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.logger.Error("failed to remove prepared self-update package", "path", path, "error", err)
	}
}

func (s *service) launch(operation Operation, current, target, installPath string, lease opkg.LeaseHandle, cleanupPath string) (Accepted, error) {
	cleanup := cleanupPath != ""

	defer func() {
		if cleanup {
			s.cleanupCandidate(cleanupPath)
		}
	}()

	if err := s.copyHelper(); err != nil {
		_ = lease.Abort()

		return Accepted{}, err
	}

	if err := s.store.ClearFailure(); err != nil {
		_ = lease.Abort()

		return Accepted{}, err
	}

	if err := s.store.WriteIntent(Intent{
		Operation:      operation,
		CurrentVersion: current,
		TargetVersion:  target,
	}); err != nil {
		_ = lease.Abort()

		return Accepted{}, err
	}

	args := []string{string(operation), current, target, installPath}

	if err := s.startProcess(s.helperPath(), args, lease.File()); err != nil {
		_ = s.store.ClearIntent()
		_ = lease.Abort()

		return Accepted{}, err
	}

	cleanup = false

	if err := lease.CommitHandoff(); err != nil {
		s.logger.Error("self-update parent lease close failed", "error", err)
	}

	return Accepted{Operation: operation, TargetVersion: target}, nil
}

func (s *service) BeginUpdate(ctx context.Context) (Accepted, error) {
	candidate, lease, err := s.manager.PrepareSelfUpdate(ctx)
	if err != nil {
		return Accepted{}, normalizeManagerError(err)
	}

	if lease == nil {
		return Accepted{}, errors.New("self-update preparation returned no lease")
	}

	return s.launch(OperationUpdate, candidate.CurrentVersion, candidate.TargetVersion, candidate.PackagePath, lease, candidate.PackagePath)
}

func (s *service) BeginRevert(ctx context.Context) (Accepted, error) {
	lease, err := s.manager.LockForSelfUpdate(ctx)
	if err != nil {
		return Accepted{}, normalizeManagerError(err)
	}

	if lease == nil {
		return Accepted{}, errors.New("self-update lock returned no lease")
	}

	target, ok := s.store.RollbackPath(s.runningVersion)

	if !ok {
		_ = lease.Abort()

		return Accepted{}, ErrNoRollback
	}

	version := s.store.RollbackVersion(s.runningVersion)

	return s.launch(OperationRevert, s.runningVersion, version, target, lease, "")
}
