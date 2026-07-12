// Package opkg wraps the device package manager (design §5.2). It has two
// implementations behind one interface: exec (runs the real `opkg` binary on the
// router) and stub (in-memory, for --dev and tests — no opkg on a dev laptop). It is
// used both by the approval flow (installing a plugin's declared dependencies) and by
// the /api/mgmt/opkg/* handlers that back the package-manager UI.
package opkg

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"strings"
)

// pkgNameRe mirrors v1's validate_pkg_name: a conservative opkg package name. Every
// name is shell-adjacent (passed to exec), so it must stay to this charset.
var pkgNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+._-]*$`)

// outputTailBytes bounds how much command output is kept for logging.
const outputTailBytes = 4 << 10

// InvalidPackageError is returned when a package name fails validation. Callers map
// it to a 400 (INVALID_PACKAGE_NAME); a package name never reaches the shell.
type InvalidPackageError struct {
	Name string
}

func (e *InvalidPackageError) Error() string {
	return "invalid package name: " + e.Name
}

// Manager is the set of opkg operations the daemon needs.
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
}

// New returns an exec-backed Manager, or a stub when mode is "stub".
func New(mode string, logger *slog.Logger) Manager {
	if mode == "stub" {
		return newStub(logger)
	}

	return &execManager{logger: logger}
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

func tail(s string) string {
	if len(s) <= outputTailBytes {
		return s
	}

	return s[len(s)-outputTailBytes:]
}

// ------------------------------------
// exec implementation
// ------------------------------------

type execManager struct {
	logger *slog.Logger
}

func (m *execManager) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "opkg", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()

	return out.String(), err
}

func (m *execManager) mutate(ctx context.Context, action string, packages []string, args ...string) error {
	if err := validate(packages); err != nil {
		return err
	}
	out, err := m.run(ctx, append(args, packages...)...)
	if err != nil {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", tail(out))

		return fmt.Errorf("opkg %s: %w", action, err)
	}

	return nil
}

func (m *execManager) Install(ctx context.Context, packages []string) error {
	return m.mutate(ctx, "install", packages, "install")
}

func (m *execManager) Remove(ctx context.Context, packages []string) error {
	return m.mutate(ctx, "remove", packages, "remove")
}

func (m *execManager) Upgrade(ctx context.Context, packages []string) error {
	return m.mutate(ctx, "upgrade", packages, "upgrade")
}

func (m *execManager) Update(ctx context.Context) error {
	out, err := m.run(ctx, "update")
	if err != nil {
		m.logger.Error("opkg update failed", "output", tail(out))

		return fmt.Errorf("opkg update: %w", err)
	}

	return nil
}

func (m *execManager) ListInstalled(ctx context.Context) ([]string, error) {
	return m.list(ctx, "list-installed")
}

func (m *execManager) ListAvailable(ctx context.Context) ([]string, error) {
	return m.list(ctx, "list")
}

func (m *execManager) list(ctx context.Context, verb string) ([]string, error) {
	out, err := m.run(ctx, verb)
	if err != nil {
		m.logger.Error("opkg list failed", "verb", verb, "output", tail(out))

		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}

	return parseNames(out), nil
}

// parseNames extracts the first whitespace field of each non-empty line, the package
// name in `opkg list` / `opkg list-installed` output ("name - version - desc").
func parseNames(out string) []string {
	names := make([]string, 0)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		names = append(names, fields[0])
	}

	return names
}
