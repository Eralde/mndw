package opkg

import (
	"context"
	"log/slog"
	"os"
	"sort"
	"sync"
	"time"
)

type stubPackage struct {
	version     string
	description string
}

// stubCatalog is the fixed set of "available" packages the stub reports on top of
// whatever has been installed. Enough to exercise the dep-install and list flows in
// --dev and tests without a real opkg.
var stubCatalog = map[string]stubPackage{
	"bash":      {version: "5.1.0-1", description: "GNU Bourne Again Shell"},
	"curl":      {version: "8.0.1-1", description: "Client URL retrieval utility"},
	"daemonize": {version: "1.7.8-1", description: "Run a program as a daemon"},
	"jq":        {version: "1.7-1", description: "Lightweight JSON processor"},
	"socat":     {version: "1.7.4.4-1", description: "Multipurpose relay for bidirectional data transfer"},
	"ttyd":      {version: "1.7.4-1", description: "Share terminal over the web"},
}

// stubManager is an in-memory opkg for --dev and tests: it tracks installed versions so
// list/install/remove/upgrade behave consistently, and logs each operation.
type stubManager struct {
	logger            *slog.Logger
	mu                sync.Mutex
	installed         map[string]string
	metadataUpdatedAt *time.Time
}

func newStub(logger *slog.Logger) *stubManager {
	return &stubManager{
		logger: logger,
		installed: map[string]string{
			"bash": "5.1.0-1",
			"jq":   "1.6-2",
		},
	}
}

func (m *stubManager) CheckSelfUpdate(ctx context.Context) (SelfUpdateCandidate, error) {
	if err := ctx.Err(); err != nil {
		return SelfUpdateCandidate{}, err
	}

	return SelfUpdateCandidate{CurrentVersion: "dev"}, nil
}

func (m *stubManager) PrepareSelfUpdate(ctx context.Context) (SelfUpdateCandidate, LeaseHandle, error) {
	if err := ctx.Err(); err != nil {
		return SelfUpdateCandidate{}, nil, err
	}

	return SelfUpdateCandidate{}, nil, ErrNoUpdate
}

func (m *stubManager) LockForSelfUpdate(ctx context.Context) (LeaseHandle, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	file, err := os.CreateTemp("", "mndw-stub-self-update-")
	if err != nil {
		return nil, err
	}

	return &stubLease{file: file, path: file.Name()}, nil
}

func (m *stubManager) SelfUpdateLocked() (bool, error) { return false, nil }

type stubLease struct {
	file   *os.File
	path   string
	closed bool
}

func (l *stubLease) File() *os.File { return l.file }

func (l *stubLease) CommitHandoff() error {
	if l.closed {
		return nil
	}

	l.closed = true
	err := l.file.Close()
	_ = os.Remove(l.path)

	return err
}

func (l *stubLease) Abort() error {
	return l.CommitHandoff()
}

func (m *stubManager) Install(ctx context.Context, packages []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := validate(packages); err != nil {
		return err
	}

	m.mu.Lock()

	for _, p := range packages {
		version := ""

		if catalog, ok := stubCatalog[p]; ok {
			version = catalog.version
		}

		m.installed[p] = version
	}

	m.mu.Unlock()
	m.logger.Info("opkg install (stub)", "packages", packages)

	return nil
}

func (m *stubManager) Remove(ctx context.Context, packages []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := rejectProtected(packages); err != nil {
		return err
	}

	if err := validate(packages); err != nil {
		return err
	}

	m.mu.Lock()

	for _, p := range packages {
		delete(m.installed, p)
	}

	m.mu.Unlock()
	m.logger.Info("opkg remove (stub)", "packages", packages)

	return nil
}

func (m *stubManager) Upgrade(ctx context.Context, packages []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := validate(packages); err != nil {
		return err
	}

	if err := rejectProtected(packages); err != nil {
		return err
	}

	m.logger.Info("opkg upgrade (stub)", "packages", packages)

	return m.Install(ctx, packages)
}

func (m *stubManager) Update(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	m.logger.Info("opkg update (stub)")

	return nil
}

func (m *stubManager) ListInstalled(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	out := make([]string, 0, len(m.installed))

	for p := range m.installed {
		out = append(out, p)
	}

	sort.Strings(out)

	return out, nil
}

func (m *stubManager) ListAvailable(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	seen := map[string]struct{}{}

	for p := range stubCatalog {
		seen[p] = struct{}{}
	}

	for p := range m.installed {
		seen[p] = struct{}{}
	}

	out := make([]string, 0, len(seen))

	for p := range seen {
		out = append(out, p)
	}

	sort.Strings(out)

	return out, nil
}

func (m *stubManager) List(ctx context.Context) (PackageList, error) {
	if err := ctx.Err(); err != nil {
		return PackageList{}, err
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	entries := make([]PackageEntry, 0, len(stubCatalog)+len(m.installed))

	for name, catalog := range stubCatalog {
		installedVersion, installed := m.installed[name]
		entry := PackageEntry{
			Name:        name,
			Version:     catalog.version,
			Description: catalog.description,
			Status:      "available",
		}

		if installed {
			entry.Version = installedVersion
			entry.Status = "installed"

			if installedVersion != catalog.version {
				entry.Status = "update_available"
				entry.NewVersion = catalog.version
			}
		}

		entries = append(entries, entry)
	}

	for name, version := range m.installed {
		if _, ok := stubCatalog[name]; ok {
			continue
		}

		entries = append(entries, PackageEntry{Name: name, Version: version, Status: "installed"})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	return PackageList{Packages: entries, MetadataUpdatedAt: m.metadataUpdatedAt}, nil
}

func (m *stubManager) Info(ctx context.Context, name string) (PackageInfo, error) {
	if err := ctx.Err(); err != nil {
		return PackageInfo{}, err
	}

	if !pkgNameRe.MatchString(name) {
		return PackageInfo{}, &InvalidPackageError{Name: name}
	}

	m.mu.Lock()

	defer m.mu.Unlock()

	catalog, available := stubCatalog[name]
	installedVersion, installed := m.installed[name]

	if !available && !installed {
		return PackageInfo{}, &PackageNotFoundError{Name: name}
	}

	version := catalog.version
	description := catalog.description
	status := "available"

	if installed {
		version = installedVersion
		status = "installed"

		if available && installedVersion != catalog.version {
			status = "update_available"
		}
	}

	return PackageInfo{
		Name:         name,
		Version:      version,
		Description:  description,
		Dependencies: []string{},
		Status:       status,
	}, nil
}
