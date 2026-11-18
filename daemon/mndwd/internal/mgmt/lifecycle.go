package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// handleApprove promotes a pending plugin: install declared packages, move
// staging → user-plugins, validate command files, then record approved+enabled.
// Dependencies install first (before
// any file move) so an opkg failure leaves the plugin cleanly pending; a failure
// after the move rolls the files back to staging so a retry is possible.
func (h *Handler) handleApprove(w http.ResponseWriter, r *http.Request) {
	name, ok := h.decodeLifecycleName(w, r)

	if !ok {
		return
	}

	m, apiErr := h.executeApprove(name)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return
	}

	h.logger.Info("plugin approved", "plugin", name)
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true, filepath.Join(h.cfg.UserPluginsDir, name)))
}

// installDeps installs a plugin's declared opkg packages. No-op when none declared.
func (h *Handler) installDeps(parent context.Context, m *manifest.Manifest) *httpx.APIError {
	packages := backendPackages(m)

	if len(packages) == 0 {
		return nil
	}

	ctx, cancel := context.WithTimeout(parent, opkgTimeout)

	defer cancel()

	if err := h.opkg.Install(ctx, packages); err != nil {
		h.logger.Error("opkg dependency install failed", "plugin", m.NameValue(), "packages", packages, "error", err)

		if errors.Is(err, opkg.ErrBusy) {
			return httpx.NewError(http.StatusConflict, httpx.CodeOpkgBusy, "package manager is busy")
		}

		return httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to install plugin dependencies")
	}

	return nil
}

func backendPackages(m *manifest.Manifest) []string {
	if m == nil || m.Backend == nil {
		return nil
	}

	return m.Backend.Packages
}

// rollbackInstall best-effort returns an install back to staging so a failed approval
// can be retried after the operator fixes the cause.
func (h *Handler) rollbackInstall(name, installPath, stagingPath string) {
	if err := moveDir(installPath, stagingPath); err != nil {
		h.logger.Error("failed to roll back plugin install to staging", "plugin", name, "error", err)
	}
}

// handleEnable re-activates a disabled approved plugin and marks it enabled.
func (h *Handler) handleEnable(w http.ResponseWriter, r *http.Request) {
	name, ok := h.decodeLifecycleName(w, r)

	if !ok {
		return
	}

	p, m, apiErr := h.lookupForToggle(name)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return
	}

	if p.Approval != state.ApprovalApproved {
		h.writeLifecycleError(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+name+" must be approved before it can be enabled"))

		return
	}

	if p.Enabled {
		h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, p.Source, p.Approval, true, h.togglePluginDir(p)))

		return
	}

	desired := &registry.Plugin{
		Name: name, Dir: h.togglePluginDir(p), Manifest: m,
		Source: p.Source, Approval: state.ApprovalApproved, Enabled: true,
	}
	err := h.executeLifecycle(name, backend.OpStarting, backend.IntentRun,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			if err := ctrl.StartPlugin(desired); err != nil {
				return err
			}

			if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
				if err != nil {
					return err
				}

				return backend.ErrLifecycleConflict
			}

			if apiErr := h.setEnabled(name, true, "enable", "plugin enabled by operator", p); apiErr != nil {
				_ = ctrl.StopService()

				return apiErr
			}

			h.reconcilePermission(name, "plugin enable")

			return nil
		})
	if err != nil {
		h.writeLifecycleError(w, lifecycleError(err, http.StatusBadGateway, httpx.CodeBackendUnavailable, "backend activation failed"))

		return
	}

	h.logger.Info("plugin enabled", "plugin", name)
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, p.Source, state.ApprovalApproved, true, h.togglePluginDir(p)))
}

// handleDisable deactivates a plugin and marks it disabled. Routes are gated on
// enabled state, and service shutdown is best effort so state cannot be wedged.
func (h *Handler) handleDisable(w http.ResponseWriter, r *http.Request) {
	name, ok := h.decodeLifecycleName(w, r)

	if !ok {
		return
	}

	p, m, apiErr := h.lookupForToggle(name)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return
	}

	if !p.Enabled {
		h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, p.Source, p.Approval, false, h.togglePluginDir(p)))

		return
	}

	err := h.executeLifecycle(name, backend.OpStopping, backend.IntentStop,
		func(_ context.Context, ctrl backend.LifecycleControl) error {
			stopErr := ctrl.StopService()
			persistErr := h.setEnabled(name, false, "disable", "plugin disabled by operator", p)

			if persistErr == nil {
				h.reconcilePermission(name, "plugin disable")
			}

			if stopErr != nil {
				return stopErr
			}

			if persistErr != nil {
				return persistErr
			}

			return nil
		})
	if err != nil {
		h.writeLifecycleError(w, lifecycleError(err, http.StatusBadGateway, httpx.CodeBackendUnavailable, "backend stop failed during disable"))

		return
	}

	h.logger.Info("plugin disabled", "plugin", name)
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, p.Source, p.Approval, false, h.togglePluginDir(p)))
}

// lookupForToggle resolves a user or builtin plugin and its manifest for enable/disable.
func (h *Handler) lookupForToggle(name string) (*state.Plugin, *manifest.Manifest, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok || p.Source == state.SourceBuiltin {
		builtin, apiErr := h.lookupBuiltin(name)

		if apiErr != nil {
			return nil, nil, apiErr
		}

		if builtin == nil {
			if !ok {
				return nil, nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
			}

			return nil, nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
		}

		builtinState, err := stateForBuiltin(builtin)
		if err != nil {
			return nil, nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot encode builtin manifest")
		}

		if ok {
			builtinState.Enabled = p.Enabled && !p.RemovalPending
			builtinState.RemovalPending = p.RemovalPending
		}

		return builtinState, builtin.Manifest, nil
	}

	m, err := manifest.Validate(p.Manifest)
	if err != nil {
		return nil, nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid")
	}

	return p, m, nil
}

func (h *Handler) lookupBuiltin(name string) (*registry.Plugin, *httpx.APIError) {
	if h.builtins != nil {
		plugins, err := h.builtins.ListBuiltins()
		if err != nil {
			return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot read builtin plugins dir")
		}

		for _, plugin := range plugins {
			if plugin.Name == name {
				return plugin, nil
			}
		}

		return nil, nil
	}

	if h.cfg.BuiltinPluginsDir == "" {
		return nil, nil
	}

	data, err := os.ReadFile(filepath.Join(h.cfg.BuiltinPluginsDir, name, manifestFileName))
	if err != nil {
		return nil, nil
	}

	m, err := manifest.Validate(data)
	if err != nil {
		return nil, nil
	}

	return &registry.Plugin{
		Name: name, Dir: filepath.Join(h.cfg.BuiltinPluginsDir, name), Manifest: m,
		Source: state.SourceBuiltin, Approval: state.ApprovalApproved, Enabled: true,
	}, nil
}

func stateForBuiltin(plugin *registry.Plugin) (*state.Plugin, error) {
	manifestJSON, err := json.Marshal(plugin.Manifest)
	if err != nil {
		return nil, err
	}

	return &state.Plugin{
		Name: plugin.Name, Source: state.SourceBuiltin, Type: plugin.Manifest.TypeValue(),
		Version: plugin.Manifest.VersionValue(), Label: plugin.Manifest.LabelValue(),
		Approval: state.ApprovalApproved, Enabled: true, Manifest: manifestJSON, InstalledAt: time.Now().UTC(),
	}, nil
}

func (h *Handler) togglePluginDir(plugin *state.Plugin) string {
	if plugin.Source == state.SourceBuiltin {
		return filepath.Join(h.cfg.BuiltinPluginsDir, plugin.Name)
	}

	return filepath.Join(h.cfg.UserPluginsDir, plugin.Name)
}

// setEnabled flips the enabled flag and audits the change. A builtin fallback is
// inserted when the first disable transition creates its persisted state record.
func (h *Handler) setEnabled(name string, enabled bool, action, detail string, fallback ...*state.Plugin) *httpx.APIError {
	return h.mutateWithAudit(action, name, detail, func(st *state.State) error {
		rec, exists := st.Plugins[name]

		if !exists {
			if len(fallback) == 0 || fallback[0] == nil || fallback[0].Source != state.SourceBuiltin {
				return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished")
			}

			copy := *fallback[0]
			rec = &copy
			st.Plugins[name] = rec
		}

		rec.Enabled = enabled

		return nil
	})
}

// handleDeny drops a pending plugin: its staging tree is removed and the record deleted.
func (h *Handler) handleDeny(w http.ResponseWriter, r *http.Request) {
	name, ok := h.decodeLifecycleName(w, r)

	if !ok {
		return
	}

	p, apiErr := h.lookupStoredPlugin(name)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return
	}

	if p.Approval != state.ApprovalPending {
		h.writeLifecycleError(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+name+" is not pending approval"))

		return
	}

	err := h.executeLifecycle(name, backend.OpDeleting, backend.IntentRemove,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			if apiErr := h.markRemovalPending(name); apiErr != nil {
				return apiErr
			}

			if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
				if err != nil {
					return err
				}

				return backend.ErrLifecycleConflict
			}

			if err := h.removePluginFiles(name, filepath.Join(h.cfg.StagingDir, name)); err != nil {
				return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to remove staged plugin")
			}

			if apiErr := h.dropRecord(name, "deny", "upload denied by operator"); apiErr != nil {
				return apiErr
			}

			return nil
		})
	if err != nil {
		h.writeLifecycleError(w, lifecycleError(err, http.StatusInternalServerError, httpx.CodeInternal, "failed to deny plugin"))

		return
	}

	h.logger.Info("plugin denied", "plugin", name)
	h.writeLifecycleJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDelete removes an installed (or still-pending) user plugin and its files.
// Builtins cannot be deleted.
func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request) {
	name, ok := h.decodeLifecycleName(w, r)

	if !ok {
		return
	}

	if h.isBuiltin(name) {
		h.writeLifecycleError(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "builtin plugins cannot be deleted"))

		return
	}

	err := h.executeLifecycle(name, backend.OpDeleting, backend.IntentRemove,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			p, exists := h.store.Get(name)

			if !exists {
				return nil
			}

			if apiErr := h.markRemovalPending(name); apiErr != nil {
				return apiErr
			}

			if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
				if err != nil {
					return err
				}

				return backend.ErrLifecycleConflict
			}

			if err := ctrl.StopService(); err != nil {
				return err
			}

			dir := h.cfg.UserPluginsDir

			if p.Approval == state.ApprovalPending {
				dir = h.cfg.StagingDir
			}

			if err := h.removePluginFiles(name, filepath.Join(dir, name)); err != nil {
				return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to remove plugin files")
			}

			if p.Approval == state.ApprovalApproved {
				h.removePluginBackups(name)
			}

			if apiErr := h.dropRecord(name, "delete", "plugin removed by operator; permission grants purged"); apiErr != nil {
				return apiErr
			}

			return nil
		})
	if err != nil {
		h.writeLifecycleError(w, lifecycleError(err, http.StatusInternalServerError, httpx.CodeInternal, "failed to delete plugin"))

		return
	}

	h.publishPluginRemoved(name)

	h.logger.Info("plugin deleted", "plugin", name)
	h.reconcilePermission(name, "plugin delete")
	h.writeLifecycleJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) markRemovalPending(name string) *httpx.APIError {
	err := h.store.Mutate(func(st *state.State) error {
		record := st.Plugins[name]

		if record == nil {
			return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
		}

		record.RemovalPending = true
		record.Enabled = false

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to persist plugin removal marker")
	}

	return nil
}

// dropRecord removes a plugin's state entry and audits the removal.
func (h *Handler) dropRecord(name, action, detail string) *httpx.APIError {
	return h.mutateWithAudit(action, name, detail, func(st *state.State) error {
		delete(st.Plugins, name)
		delete(st.PermissionGrants, name)

		return nil
	})
}

// markCommandsExecutable applies +x to every declared backend command.
// A declared-but-absent file is a packaging error and fails approval.
func markCommandsExecutable(installPath string, m *manifest.Manifest) *httpx.APIError {
	if m.Backend == nil {
		return nil
	}

	paths := make([]string, 0, len(m.Backend.Routes)+1)

	if m.Backend.Command != nil {
		paths = append(paths, *m.Backend.Command)
	}

	for _, route := range m.Backend.Routes {
		if route.Command != "" {
			paths = append(paths, route.Command)
		}
	}

	for _, rel := range paths {
		abs, err := safeJoin(installPath, rel)
		if err != nil {
			return httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "backend command path escapes plugin dir: "+rel)
		}

		if err := chmodExecutable(abs); err != nil {
			return httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "declared backend command missing or unreadable: "+rel)
		}
	}

	return nil
}

// isBuiltin reports whether a plugin of this name ships in the builtin dir.
func (h *Handler) isBuiltin(name string) bool {
	if h.cfg.BuiltinPluginsDir == "" {
		return false
	}

	_, err := os.Stat(filepath.Join(h.cfg.BuiltinPluginsDir, name, manifestFileName))

	return err == nil
}
