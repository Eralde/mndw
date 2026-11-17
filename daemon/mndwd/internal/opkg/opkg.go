// Package opkg wraps the device package manager. It has two
// implementations behind one interface: exec (runs the real `opkg` binary on the
// device) and stub (in-memory, for --dev and tests — no opkg on a dev laptop). It is
// used both by the approval flow (installing a plugin's declared dependencies) and by
// the /api/mgmt/opkg/* handlers that back the package-manager UI.
package opkg

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
)

// pkgNameRe accepts a conservative opkg package name. Every name is shell-adjacent
// (passed to exec), so it must stay within this character set.
var pkgNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+._-]*$`)

var ErrOpkgUnavailable = errors.New("opkg unavailable")

// InvalidPackageError is returned when a package name fails validation. Callers map
// it to a 400 (INVALID_PACKAGE_NAME); a package name never reaches the shell.
type InvalidPackageError struct {
	Name string
}

type ProtectedPackageError struct{ Name string }

func (e *ProtectedPackageError) Error() string { return "protected package: " + e.Name }

// DependencyConflictError is returned when a removal is refused because other
// installed packages depend on the target. opkg prints a "depended upon by
// packages" warning and — on the device's opkg build — exits 0 without removing
// anything, so this must be detected from the command output, not the exit code.
type DependencyConflictError struct {
	// Package is the package whose removal was refused.
	Package string
	// DependedBy lists the installed packages that depend on Package.
	DependedBy []string
}

func (e *DependencyConflictError) Error() string {
	if len(e.DependedBy) > 0 {
		return fmt.Sprintf("cannot remove %s: required by %s", e.Package, strings.Join(e.DependedBy, ", "))
	}

	return "cannot remove " + e.Package + ": required by other installed packages"
}

type PackageInfo struct {
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Description   string   `json:"description"`
	Size          string   `json:"size,omitempty"`
	InstalledSize string   `json:"installedSize,omitempty"`
	Dependencies  []string `json:"dependencies"`
	Status        string   `json:"status"`
	InstalledTime string   `json:"installedTime,omitempty"`
}

type PackageList struct {
	Packages          []PackageEntry `json:"packages"`
	MetadataUpdatedAt *time.Time     `json:"metadataUpdatedAt"`
}

func (e *InvalidPackageError) Error() string {
	return "invalid package name: " + e.Name
}

// PackageEntry is one package as reported by the rich package listing.
type PackageEntry struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Status      string `json:"status"`
	NewVersion  string `json:"newVersion,omitempty"`
}

// Manager is the set of opkg operations the daemon needs.
//
// Cancellation contract: every method MUST return promptly once ctx is done —
// whether waiting to start (the mutation gate) or mid-operation. The startup
// coordinator's bounded shutdown join relies on this; any new implementation
// must honor it.
type Manager interface {
	// Install installs the named packages (plugin deps or an explicit request).
	Install(ctx context.Context, packages []string) error
	// Remove uninstalls the named packages.
	Remove(ctx context.Context, packages []string) error
	// Update refreshes the package metadata index.
	Update(ctx context.Context) error
	// Upgrade upgrades the named packages to their latest available version.
	Upgrade(ctx context.Context, packages []string) error
	// ListInstalled returns the names of installed packages.
	ListInstalled(ctx context.Context) ([]string, error)
	// ListAvailable returns the names of packages available to install.
	ListAvailable(ctx context.Context) ([]string, error)
	// List returns a merged package listing and device metadata freshness.
	List(ctx context.Context) (PackageList, error)
	// Info returns available-feed details overlaid with installed-only fields.
	Info(ctx context.Context, name string) (PackageInfo, error)
}

// NewStub returns an in-memory manager for development and tests.
func NewStub(logger *slog.Logger) SelfUpdateManager {
	if logger == nil {
		logger = slog.Default()
	}

	return newStub(logger)
}

// NewExecWithPaths returns a manager backed by the device's opkg executable.
func NewExecWithPaths(logger *slog.Logger, paths Paths) SelfUpdateManager {
	if logger == nil {
		logger = slog.Default()
	}

	return &execManager{
		logger:     logger,
		listsDir:   "/opt/var/opkg-lists/",
		stateDir:   paths.StateDir,
		pendingDir: paths.PendingDir,
		lockPath:   paths.LockPath,
		gate:       make(chan struct{}, 1),
	}
}

// validate rejects an empty list or any malformed package name before exec.
func validate(packages []string) error {
	if len(packages) == 0 {
		return fmt.Errorf("packages must be a non-empty list")
	}

	for _, p := range packages {
		if !pkgNameRe.MatchString(p) {
			return &InvalidPackageError{Name: p}
		}
	}

	return nil
}
