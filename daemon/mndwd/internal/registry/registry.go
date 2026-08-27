// Package registry resolves an installed plugin by name into its validated
// manifest, on-disk directory, and approval/enabled gate state.
package registry

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

// Plugin is a resolved plugin ready to serve backend traffic.
type Plugin struct {
	// Name is the plugin's manifest name (also its dir name).
	Name string
	// Dir is the absolute directory the plugin's files live in.
	Dir string
	// Manifest is the re-validated manifest, the source of endpoint/ws routes.
	Manifest *manifest.Manifest
	// Source is builtin or user (state.Source*).
	Source state.Source
	// Approval and Enabled are the runtime gate; only approved+enabled plugins serve.
	Approval state.Approval
	Enabled  bool
	// RemovalPending is the durable crash-recovery tombstone for cleanup.
	RemovalPending bool
}

// BackendServable reports whether the plugin's backend may serve traffic: it
// must be approved and enabled. It returns nil when servable, or the matching
// 403 APIError.
func (p *Plugin) BackendServable() *httpx.APIError {
	if p.Approval != state.ApprovalApproved {
		return httpx.NewError(http.StatusForbidden, httpx.CodeNotApproved, "plugin backend is not approved")
	}

	if !p.Enabled {
		return httpx.NewError(http.StatusForbidden, httpx.CodeDisabled, "plugin backend is disabled")
	}

	return nil
}

// Registry resolves plugin names against live state plus the builtin plugin dir.
type Registry struct {
	store      *state.Store
	userDir    string
	builtinDir string
	logger     *slog.Logger
}

// New constructs a Registry over the given state store and plugin directories.
func New(store *state.Store, userDir, builtinDir string) *Registry {
	return NewWithLogger(store, userDir, builtinDir, nil)
}

// NewWithLogger constructs a Registry with an optional logger for builtin
// manifest validation warnings.
func NewWithLogger(store *state.Store, userDir, builtinDir string, logger *slog.Logger) *Registry {
	return &Registry{store: store, userDir: userDir, builtinDir: builtinDir, logger: logger}
}

// Resolve returns the named plugin, or false if no such plugin is installed. User
// plugins come from state (their exact validated manifest bytes); builtins are read
// from disk and treated as always approved+enabled. A stored manifest
// that no longer validates is treated as not found — a tampered state file must not
// open a backend route.
func (r *Registry) Resolve(name string) (*Plugin, bool) {
	if rec, ok := r.store.Get(name); ok {
		m, err := manifest.ValidateV3(rec.Manifest)
		if err != nil {
			return nil, false
		}

		return &Plugin{
			Name:           name,
			Dir:            pluginDir(r.userDir, rec),
			Manifest:       m,
			Source:         rec.Source,
			Approval:       rec.Approval,
			Enabled:        rec.Enabled && !rec.RemovalPending,
			RemovalPending: rec.RemovalPending,
		}, true
	}

	if r.builtinDir != "" {
		data, err := os.ReadFile(filepath.Join(r.builtinDir, name, "manifest.json"))
		if err == nil {
			if m, verr := manifest.ValidateV3(data); verr == nil {
				return &Plugin{
					Name:     name,
					Dir:      filepath.Join(r.builtinDir, name),
					Manifest: m,
					Source:   state.SourceBuiltin,
					Approval: state.ApprovalApproved,
					Enabled:  true,
				}, true
			}
		}
	}

	return nil, false
}

func pluginDir(userDir string, record *state.Plugin) string {
	defaultDir := filepath.Join(userDir, record.Name)

	if record.ActiveVersionDir == "" || !filepath.IsAbs(record.ActiveVersionDir) {
		return defaultDir
	}

	rel, err := filepath.Rel(userDir, record.ActiveVersionDir)
	if err != nil || rel == ".." || filepath.IsAbs(rel) || (len(rel) >= 3 && rel[:3] == ".."+string(filepath.Separator)) {
		return defaultDir
	}

	return record.ActiveVersionDir
}

// ListBuiltins returns every plugin discovered in the builtin directory. Builtins are
// always treated as approved+enabled. The caller is responsible for filtering (e.g.
// for the management list).
func (r *Registry) ListBuiltins() []*Plugin {
	plugins, err := r.ListBuiltinsWithError()
	if err != nil {
		return nil
	}

	return plugins
}

// ListBuiltinsWithError returns every valid builtin plugin and reports an
// unreadable builtin directory. Missing directories remain an empty result.
func (r *Registry) ListBuiltinsWithError() ([]*Plugin, error) {
	if r.builtinDir == "" {
		return nil, nil
	}

	entries, err := os.ReadDir(r.builtinDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}

		return nil, err
	}

	var plugins []*Plugin

	for _, entry := range entries {
		name := entry.Name()
		pluginDir := filepath.Join(r.builtinDir, name)
		info, statErr := os.Stat(pluginDir)

		if statErr != nil || !info.IsDir() {
			continue
		}

		data, readErr := os.ReadFile(filepath.Join(pluginDir, "manifest.json"))

		if readErr != nil {
			continue
		}

		m, verr := manifest.ValidateV3(data)

		if verr != nil {
			if r.logger != nil {
				r.logger.Warn("builtin plugin has invalid manifest, skipping", "plugin", name, "error", verr)
			}

			continue
		}

		plugins = append(plugins, &Plugin{
			Name:     name,
			Dir:      pluginDir,
			Manifest: m,
			Source:   state.SourceBuiltin,
			Approval: state.ApprovalApproved,
			Enabled:  true,
		})
	}

	return plugins, nil
}

// AllBackendPlugins returns active plugins with backend capabilities. State
// records reserve names before approval filtering so state remains authoritative
// over same-name builtins.
func (r *Registry) AllBackendPlugins() []*Plugin {
	snapshot := r.store.Snapshot()
	reserved := make(map[string]struct{}, len(snapshot.Plugins))
	userNames := make([]string, 0, len(snapshot.Plugins))

	for name := range snapshot.Plugins {
		reserved[name] = struct{}{}
		userNames = append(userNames, name)
	}

	sort.Strings(userNames)

	plugins := make([]*Plugin, 0)

	for _, name := range userNames {
		record := snapshot.Plugins[name]

		if record == nil || record.Approval != state.ApprovalApproved || !record.Enabled {
			continue
		}

		plugin, ok := r.Resolve(name)

		if !ok || !manifest.HasBackend(plugin.Manifest) {
			continue
		}

		plugins = append(plugins, plugin)
	}

	builtins := r.ListBuiltins()

	sort.Slice(builtins, func(left, right int) bool { return builtins[left].Name < builtins[right].Name })

	for _, plugin := range builtins {
		if _, exists := reserved[plugin.Name]; exists || !manifest.HasBackend(plugin.Manifest) {
			continue
		}

		plugins = append(plugins, plugin)
	}

	return plugins
}
