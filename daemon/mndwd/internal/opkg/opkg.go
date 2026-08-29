// Package opkg wraps the device package manager. It has two
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
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"mndwd/internal/output"
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

// New returns an exec-backed Manager, or a stub when mode is "stub".
func New(mode string, logger *slog.Logger) Manager {
	if logger == nil {
		logger = slog.Default()
	}
	if mode == "stub" {
		return newStub(logger)
	}

	return &execManager{logger: logger, listsDir: "/opt/var/opkg-lists/", gate: make(chan struct{}, 1)}
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

// ------------------------------------
// exec implementation
// ------------------------------------

type execManager struct {
	logger   *slog.Logger
	runner   func(ctx context.Context, args ...string) (string, int, error)
	listsDir string
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
	if errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err) {
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

// acquire takes the mutation gate, aborting immediately when ctx is done. The
// pre-check matters because with an empty gate and a done context both select
// cases are ready and Go picks randomly.
func (m *execManager) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case m.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *execManager) release() {
	<-m.gate
}

func (m *execManager) mutate(ctx context.Context, action string, packages []string, args ...string) error {
	m.defaults()
	if err := validate(packages); err != nil {
		return err
	}

	if err := m.acquire(ctx); err != nil {
		return fmt.Errorf("opkg %s: %w", action, err)
	}

	defer m.release()

	commandArgs := append([]string{"opkg"}, args...)
	commandArgs = append(commandArgs, packages...)
	out, exitCode, err := m.run(ctx, commandArgs...)
	if err != nil {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", output.Tail(out))

		return fmt.Errorf("opkg %s: %w", action, err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg command failed", "action", action, "packages", packages, "output", output.Tail(out), "exitCode", exitCode)

		return fmt.Errorf("opkg %s exited %d", action, exitCode)
	}

	return nil
}

func (m *execManager) Install(ctx context.Context, packages []string) error {
	return m.mutate(ctx, "install", packages, "install")
}

func (m *execManager) Remove(ctx context.Context, packages []string) error {
	if err := rejectProtected(packages); err != nil {
		return err
	}
	return m.mutate(ctx, "remove", packages, "remove")
}

func (m *execManager) Upgrade(ctx context.Context, packages []string) error {
	if err := rejectProtected(packages); err != nil {
		return err
	}
	return m.mutate(ctx, "upgrade", packages, "upgrade")
}

func (m *execManager) Update(ctx context.Context) error {
	m.defaults()
	if err := m.acquire(ctx); err != nil {
		return fmt.Errorf("opkg update: %w", err)
	}

	defer m.release()

	out, exitCode, err := m.run(ctx, "opkg", "update")
	if err != nil {
		m.logger.Error("opkg update failed", "output", output.Tail(out))

		return fmt.Errorf("opkg update: %w", err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg update failed", "output", output.Tail(out), "exitCode", exitCode)

		return fmt.Errorf("opkg update exited %d", exitCode)
	}

	return nil
}

func rejectProtected(packages []string) error {
	for _, name := range packages {
		if name == "mndw" || name == "lighttpd" {
			return &ProtectedPackageError{Name: name}
		}
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
		m.logger.Error("opkg list failed", "verb", verb, "output", output.Tail(out))

		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}

	if exitCode != 0 {
		m.logger.Error("opkg list failed", "verb", verb, "output", output.Tail(out), "exitCode", exitCode)

		return nil, fmt.Errorf("opkg %s exited %d", verb, exitCode)
	}

	return parseNames(out), nil
}

func (m *execManager) List(ctx context.Context) (PackageList, error) {
	installedMap, installedErr := m.listMap(ctx, "list-installed")

	availableMap, availableErr := m.listMap(ctx, "list")

	if installedErr != nil && availableErr != nil {
		return PackageList{}, fmt.Errorf("opkg list-installed: %w; opkg list: %w", installedErr, availableErr)
	}

	combined := mergePackageMaps(installedMap, availableMap)
	metadataUpdatedAt, err := m.metadataUpdatedAt()
	if err != nil {
		return PackageList{}, err
	}
	return PackageList{Packages: combined, MetadataUpdatedAt: metadataUpdatedAt}, nil
}

func mergePackageMaps(installedMap, availableMap map[string]PackageEntry) []PackageEntry {
	combined := make([]PackageEntry, 0, len(installedMap)+len(availableMap))

	for name, available := range availableMap {
		installed, ok := installedMap[name]

		if !ok {
			available.Status = "available"
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

	return combined
}

type packageInfoBlock struct {
	Name          string
	Version       string
	Description   string
	Size          string
	Dependencies  []string
	InstalledSize string
	InstalledTime string
}

type PackageNotFoundError struct{ Name string }

func (e *PackageNotFoundError) Error() string { return "package not found: " + e.Name }

func (m *execManager) Info(ctx context.Context, name string) (PackageInfo, error) {
	m.defaults()
	if !pkgNameRe.MatchString(name) {
		return PackageInfo{}, &InvalidPackageError{Name: name}
	}
	out, exitCode, err := m.run(ctx, "opkg", "info", name)
	if err != nil {
		return PackageInfo{}, fmt.Errorf("opkg info: %w", err)
	}
	if exitCode != 0 {
		return PackageInfo{}, &PackageNotFoundError{Name: name}
	}
	blocks, err := parseInfoBlocks(out)
	if err != nil {
		return PackageInfo{}, err
	}

	installedMap, _ := m.listMap(ctx, "list-installed")
	availableMap, _ := m.listMap(ctx, "list")
	installedVersion := ""
	if installed, ok := installedMap[name]; ok {
		installedVersion = installed.Version
	}
	selected, err := selectInfoBlock(blocks, name, installedVersion)
	if err != nil {
		return PackageInfo{}, err
	}

	info := PackageInfo{
		Name:         selected.Name,
		Version:      selected.Version,
		Description:  selected.Description,
		Size:         selected.Size,
		Dependencies: selected.Dependencies,
		Status:       derivePackageStatus(name, installedMap, availableMap),
	}
	statusOut, statusExit, statusErr := m.run(ctx, "opkg", "status", name)
	if statusErr == nil && statusExit == 0 {
		statusBlocks, parseErr := parseInfoBlocks(statusOut)
		if parseErr == nil {
			if statusBlock, findErr := selectInfoBlock(statusBlocks, name, installedVersion); findErr == nil {
				info.InstalledSize = statusBlock.InstalledSize
				info.InstalledTime = statusBlock.InstalledTime
			}
		}
	}
	return info, nil
}

func derivePackageStatus(name string, installedMap, availableMap map[string]PackageEntry) string {
	installed, installedOK := installedMap[name]
	available, availableOK := availableMap[name]
	if !installedOK {
		return "available"
	}
	if availableOK && installed.Version != available.Version {
		return "update_available"
	}
	return "installed"
}

func isArchitectureWarning(line string) bool {
	return strings.HasPrefix(line, "Package ") && strings.HasSuffix(line, " has no valid architecture, ignoring.")
}

func parseInfoBlocks(out string) ([]packageInfoBlock, error) {
	blocks := make([]packageInfoBlock, 0)
	for _, rawBlock := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n\n") {
		blockText := strings.TrimSpace(rawBlock)
		if blockText == "" {
			continue
		}
		block := packageInfoBlock{Dependencies: []string{}}
		lastField := ""
		for _, line := range strings.Split(blockText, "\n") {
			rawLine := strings.TrimRight(line, "\r")
			line = strings.TrimSpace(rawLine)
			if line == "" {
				continue
			}
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				// A line without a colon is a continuation of the previous
				// field: either a wrapped Description line, or an entry in a
				// multi-valued field such as Conffiles (a path plus checksum).
				if lastField == "Description" {
					if block.Description != "" {
						block.Description += "\n"
					}
					block.Description += line
				}

				continue
			}
			lastField = strings.TrimSpace(key)
			value = strings.TrimSpace(value)
			switch lastField {
			case "Package":
				block.Name = value
			case "Version":
				block.Version = value
			case "Description":
				block.Description = value
			case "Size":
				block.Size = value
			case "Depends":
				if value != "" {
					for _, dependency := range strings.Split(value, ",") {
						block.Dependencies = append(block.Dependencies, strings.TrimSpace(dependency))
					}
				}
			case "Installed-Size":
				block.InstalledSize = value
			case "Installed-Time":
				block.InstalledTime = value
			}
		}
		if block.Name == "" || block.Version == "" {
			return nil, fmt.Errorf("malformed opkg info block: missing package or version")
		}
		blocks = append(blocks, block)
	}
	return blocks, nil
}

func selectInfoBlock(blocks []packageInfoBlock, name, installedVersion string) (packageInfoBlock, error) {
	for _, block := range blocks {
		if block.Name == name && installedVersion != "" && block.Version == installedVersion {
			return block, nil
		}
	}
	for _, block := range blocks {
		if block.Name == name {
			return block, nil
		}
	}
	return packageInfoBlock{}, &PackageNotFoundError{Name: name}
}

func (m *execManager) metadataUpdatedAt() (*time.Time, error) {
	m.defaults()
	entries, err := os.ReadDir(m.listsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read opkg lists directory: %w", err)
	}
	var newest time.Time
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() {
			continue
		}
		modified := info.ModTime().UTC()
		if newest.IsZero() || modified.After(newest) {
			newest = modified
		}
	}
	if newest.IsZero() {
		return nil, nil
	}
	return &newest, nil
}

func (m *execManager) listMap(ctx context.Context, verb string) (map[string]PackageEntry, error) {
	out, exitCode, err := m.run(ctx, "opkg", verb)
	if err != nil {
		return nil, fmt.Errorf("opkg %s: %w", verb, err)
	}

	if exitCode != 0 {
		return nil, fmt.Errorf("opkg %s exited %d", verb, exitCode)
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
		line = strings.TrimSpace(line)

		if line == "" || isArchitectureWarning(line) {
			continue
		}

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
		line := strings.TrimSuffix(rawLine, "\r")
		trimmedLine := strings.TrimSpace(line)

		if trimmedLine == "" || isArchitectureWarning(trimmedLine) {
			continue
		}

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
