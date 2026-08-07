// Package registry resolves an installed plugin by name into the concrete data the
// HTTP dispatcher and the WS proxy need: its validated manifest, on-disk directory,
// and the approval/enabled/public gate state. It is the single route source used
// by both backend traffic handlers, so a plugin's reachability is
// decided in exactly one place rather than drifting between the two.
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
	Source string
	// Approval and Enabled are the runtime gate; only approved+enabled plugins serve.
	Approval string
	Enabled  bool
}

// Public reports whether the plugin opted its backend out of the session gate
// (backend.public). Public routes still require approval + enabled — public only
// skips the cookie check.
func (p *Plugin) Public() bool {
	d := manifest.Descriptor(p.Manifest)

	return d != nil && d.Public
}

// BackendServable reports whether the plugin's backend may serve traffic: it
// must be approved and enabled. It returns nil when servable, or the matching
// 403 APIError. dispatch and wsproxy both gate on this so the rule is defined
// in exactly one place.
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
		m, err := manifest.Validate(rec.Manifest)
		if err != nil {
			return nil, false
		}

		return &Plugin{
			Name:     name,
			Dir:      filepath.Join(r.userDir, name),
			Manifest: m,
			Source:   rec.Source,
			Approval: rec.Approval,
			Enabled:  rec.Enabled,
		}, true
	}

	if r.builtinDir != "" {
		data, err := os.ReadFile(filepath.Join(r.builtinDir, name, "manifest.json"))
		if err == nil {
			if m, verr := manifest.Validate(data); verr == nil {
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

// ListBuiltins returns every plugin discovered in the builtin directory. Builtins are
// always treated as approved+enabled. The caller is responsible for filtering (e.g.
// for daemon hooks, for the mgmt list).
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

		m, verr := manifest.Validate(data)
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

// AllDaemonPlugins returns active backend plugins that declare daemon hooks.
func (r *Registry) AllDaemonPlugins() []*Plugin {
	plugins := r.AllBackendPlugins()
	daemons := make([]*Plugin, 0, len(plugins))
	for _, plugin := range plugins {
		if plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Daemon == nil {
			continue
		}
		daemons = append(daemons, plugin)
	}

	return daemons
}
