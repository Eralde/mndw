package mgmt

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
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
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true))
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
		h.logger.Error("opkg dependency install failed", "plugin", deref(m.Name), "packages", packages, "error", err)

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
		h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, true))

		return
	}

	desired := &registry.Plugin{
		Name: name, Dir: filepath.Join(h.cfg.UserPluginsDir, name), Manifest: m,
		Source: p.Source, Approval: state.ApprovalApproved, Enabled: true,
	}
	err := h.executeLifecycle(name, backend.OpStarting, backend.IntentRun, backend.TerminalRun, backend.FailRestore,
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

			if apiErr := h.setEnabled(name, true, "enable", "plugin enabled by operator"); apiErr != nil {
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
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true))
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
		h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, false))

		return
	}

	err := h.executeLifecycle(name, backend.OpStopping, backend.IntentStop, backend.TerminalStop, backend.FailKeep,
		func(_ context.Context, ctrl backend.LifecycleControl) error {
			stopErr := ctrl.StopService()
			persistErr := h.setEnabled(name, false, "disable", "plugin disabled by operator")

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
	h.writeLifecycleJSON(w, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, false))
}

// lookupForToggle resolves a user plugin and its manifest for enable/disable,
// mapping the builtin and unknown cases to their errors.
func (h *Handler) lookupForToggle(name string) (*state.Plugin, *manifest.Manifest, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok {
		if h.isBuiltin(name) {
			return nil, nil, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "builtin plugins are always enabled")
		}

		return nil, nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
	}

	m, err := manifest.ValidateV3(p.Manifest)
	if err != nil {
		return nil, nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid")
	}

	return p, m, nil
}

// setEnabled flips the enabled flag and audits the change.
func (h *Handler) setEnabled(name string, enabled bool, action, detail string) *httpx.APIError {
	return h.mutateWithAudit(action, name, detail, func(st *state.State) error {
		rec, exists := st.Plugins[name]

		if !exists {
			return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished")
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

	err := h.executeLifecycle(name, backend.OpDeleting, backend.IntentRemove, backend.TerminalRemove, backend.FailRemoved,
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

	err := h.executeLifecycle(name, backend.OpDeleting, backend.IntentRemove, backend.TerminalRemove, backend.FailRemoved,
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

			if apiErr := h.dropRecord(name, "delete", "plugin removed by operator; permission grants purged"); apiErr != nil {
				return apiErr
			}

			return nil
		})
	if err != nil {
		h.writeLifecycleError(w, lifecycleError(err, http.StatusInternalServerError, httpx.CodeInternal, "failed to delete plugin"))

		return
	}

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
