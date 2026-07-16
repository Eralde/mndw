// Package opkg wraps the device package manager (design §5.2). It has two
// implementations behind one interface: exec (runs the real `opkg` binary on the
// router) and stub (in-memory, for --dev and tests — no opkg on a dev laptop). It is
// used both by the approval flow (installing a plugin's declared dependencies) and by
// the /api/mgmt/opkg/* handlers that back the package-manager UI.
package opkg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"sort"
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

// PackageEntry is one package as reported by the rich package listing.
type PackageEntry struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Status      string `json:"status"`
	NewVersion  string `json:"newVersion,omitempty"`
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
	// List returns a merged, version-aware package listing.
	List(ctx context.Context) ([]PackageEntry, error)
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
	runner func(ctx context.Context, args ...string) (string, int, error)
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
	if m.runner != nil {
		return m.runner(ctx, args...)
	}

	return execRun(ctx, args...)
}

func (m *execManager) mutate(ctx context.Context, action string, packages []string, args ...string) error {
	if err := validate(packages); err != nil {
		return err
	}
	commandArgs := append([]string{"opkg"}, args...)
	commandArgs = append(commandArgs, packages...)
	out, exitCode, err := m.run(ctx, commandArgs...)
	if err != nil {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", tail(out))

		return fmt.Errorf("opkg %s: %w", action, err)
	}
	if exitCode != 0 {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", tail(out), "exitCode", exitCode)

		return fmt.Errorf("opkg %s exited %d", action, exitCode)
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
	out, exitCode, err := m.run(ctx, "opkg", "update")
	if err != nil {
		m.logger.Error("opkg update failed", "output", tail(out))

		return fmt.Errorf("opkg update: %w", err)
	}
	if exitCode != 0 {
		m.logger.Error("opkg update failed", "output", tail(out), "exitCode", exitCode)

		return fmt.Errorf("opkg update exited %d", exitCode)
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
	out, exitCode, err := m.run(ctx, "opkg", verb)
	if err != nil {
		m.logger.Error("opkg list failed", "verb", verb, "output", tail(out))

		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}
	if exitCode != 0 {
		m.logger.Error("opkg list failed", "verb", verb, "output", tail(out), "exitCode", exitCode)

		return nil, fmt.Errorf("opkg %s exited %d", verb, exitCode)
	}

	return parseNames(out), nil
}

func (m *execManager) List(ctx context.Context) ([]PackageEntry, error) {
	installedMap, installedErr := m.listInstalledMap(ctx)

	availableMap, availableErr := m.listAvailableMap(ctx)

	if installedErr != nil && availableErr != nil {
		return nil, fmt.Errorf("opkg list-installed: %w; opkg list: %w", installedErr, availableErr)
	}

	combined := make([]PackageEntry, 0, len(installedMap)+len(availableMap))
	for name, available := range availableMap {
		installed, ok := installedMap[name]
		if !ok {
			available.Status = "uninstalled"
			combined = append(combined, available)

			continue
		}

		description := installed.Description
		if available.Description != "" {
			description = available.Description
		}

		entry := PackageEntry{
			Name:        name,
			Version:     installed.Version,
			Description: description,
			Status:      "installed",
		}
		if installed.Version != available.Version {
			entry.Status = "update_available"
			entry.NewVersion = available.Version
		}
		combined = append(combined, entry)
	}
	for name, installed := range installedMap {
		if _, ok := availableMap[name]; ok {
			continue
		}
		installed.Status = "installed"
		installed.NewVersion = ""
		combined = append(combined, installed)
	}

	sort.Slice(combined, func(i, j int) bool { return combined[i].Name < combined[j].Name })

	return combined, nil
}

func (m *execManager) listInstalledMap(ctx context.Context) (map[string]PackageEntry, error) {
	out, exitCode, err := m.run(ctx, "opkg", "list-installed")
	if err != nil {
		return nil, fmt.Errorf("opkg list-installed: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("opkg list-installed exited %d", exitCode)
	}
	entries, err := parseEntries(out)
	if err != nil {
		return nil, err
	}
	result := make(map[string]PackageEntry, len(entries))
	for _, entry := range entries {
		result[entry.Name] = entry
	}

	return result, nil
}

func (m *execManager) listAvailableMap(ctx context.Context) (map[string]PackageEntry, error) {
	out, exitCode, err := m.run(ctx, "opkg", "list")
	if err != nil {
		return nil, fmt.Errorf("opkg list: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("opkg list exited %d", exitCode)
	}
	entries, err := parseEntries(out)
	if err != nil {
		return nil, err
	}
	result := make(map[string]PackageEntry, len(entries))
	for _, entry := range entries {
		result[entry.Name] = entry
	}

	return result, nil
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

func parseEntries(out string) ([]PackageEntry, error) {
	entries := make([]PackageEntry, 0)
	for i, rawLine := range strings.Split(out, "\n") {
		if strings.TrimSpace(rawLine) == "" {
			continue
		}
		line := strings.TrimSuffix(rawLine, "\r")
		parts := strings.SplitN(line, " - ", 3)
		if len(parts) < 2 {
			return nil, fmt.Errorf("malformed opkg output line %d: %q", i+1, strings.TrimSpace(line))
		}
		name := strings.TrimSpace(parts[0])
		version := strings.TrimSpace(parts[1])
		if name == "" || version == "" {
			return nil, fmt.Errorf("malformed opkg output line %d: %q", i+1, strings.TrimSpace(line))
		}
		description := ""
		if len(parts) >= 3 {
			description = strings.TrimSpace(parts[2])
		}
		entries = append(entries, PackageEntry{
			Name:        name,
			Version:     version,
			Description: description,
		})
	}

	return entries, nil
}
