package opkg

import (
	"context"
	"log/slog"
	"sort"
	"sync"
)

// stubCatalog is the fixed set of "available" packages the stub reports on top of
// whatever has been installed. Enough to exercise the dep-install and list flows in
// --dev and tests without a real opkg.
var stubCatalog = []string{"bash", "curl", "daemonize", "jq", "socat", "ttyd"}

// stubManager is an in-memory opkg for --dev and tests: it tracks an installed set so
// list/install/remove behave consistently, and logs each operation.
type stubManager struct {
	logger    *slog.Logger
	mu        sync.Mutex
	installed map[string]struct{}
}

func newStub(logger *slog.Logger) *stubManager {
	return &stubManager{logger: logger, installed: map[string]struct{}{}}
}

func (m *stubManager) Install(_ context.Context, packages []string) error {
	if err := validate(packages); err != nil {
		return err
	}
	m.mu.Lock()
	for _, p := range packages {
		m.installed[p] = struct{}{}
	}
	m.mu.Unlock()
	m.logger.Info("opkg install (stub)", "packages", packages)

	return nil
}

func (m *stubManager) Remove(_ context.Context, packages []string) error {
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
	if err := validate(packages); err != nil {
		return err
	}
	m.logger.Info("opkg upgrade (stub)", "packages", packages)

	return m.Install(ctx, packages)
}

func (m *stubManager) Update(_ context.Context) error {
	m.logger.Info("opkg update (stub)")

	return nil
}

func (m *stubManager) ListInstalled(_ context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]string, 0, len(m.installed))
	for p := range m.installed {
		out = append(out, p)
	}
	sort.Strings(out)

	return out, nil
}

func (m *stubManager) ListAvailable(_ context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	seen := map[string]struct{}{}
	for _, p := range stubCatalog {
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
