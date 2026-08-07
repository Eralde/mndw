// Package registry resolves an installed plugin by name into the concrete data the
// HTTP dispatcher and the WS proxy need: its validated manifest, on-disk directory,
// and the approval/enabled/public gate state. It is the single route source used
// by both backend traffic handlers, so a plugin's reachability is
// decided in exactly one place rather than drifting between the two.
package registry

import (
	"os"
	"path/filepath"

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

// Registry resolves plugin names against live state plus the builtin plugin dir.
type Registry struct {
	store      *state.Store
	userDir    string
	builtinDir string
}

// New constructs a Registry over the given state store and plugin directories.
func New(store *state.Store, userDir, builtinDir string) *Registry {
	return &Registry{store: store, userDir: userDir, builtinDir: builtinDir}
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
	if r.builtinDir == "" {
		return nil
	}

	entries, err := os.ReadDir(r.builtinDir)
	if err != nil {
		return nil
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

	return plugins
}
