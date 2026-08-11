package mgmt

import (
	"net/http"
	"os"
	"path/filepath"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

// handleApprove promotes a pending plugin: install declared packages, move
// staging → user-plugins, validate command files, then record approved+enabled.
// Dependencies install first (before
// any file move) so an opkg failure leaves the plugin cleanly pending; a failure
// after the move rolls the files back to staging so a retry is possible.
func (h *Handler) handleApprove(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	m, apiErr := h.executeApprove(name)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin approved", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true))
}

// installDeps installs a plugin's declared opkg packages. No-op when none declared.
func (h *Handler) installDeps(m *manifest.Manifest) *httpx.APIError {
	packages := backendPackages(m)

	if len(packages) == 0 {
		return nil
	}

	ctx, cancel := opkgContext()

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
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	p, m, apiErr := h.lookupForToggle(name)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	if p.Approval != state.ApprovalApproved {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+name+" must be approved before it can be enabled"))

		return
	}

	if p.Enabled {
		httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, true))

		return
	}

	if h.runtime != nil {
		if err := h.activateBackendPlugin(name, m, filepath.Join(h.cfg.UserPluginsDir, name), true); err != nil {
			if serviceCapacityError(err) {
				httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeServiceCapacityExceeded, "service capacity exceeded"))

				return
			}

			h.logger.Warn("backend activation deferred", "plugin", name, "error", err)
		}
	}

	if apiErr := h.setEnabled(name, true, "enable", "plugin enabled by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin enabled", "plugin", name)
	h.reconcilePermission(name, "plugin enable")
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true))
}

// handleDisable deactivates a plugin and marks it disabled. Routes are gated on
// enabled state, and service shutdown is best effort so state cannot be wedged.
func (h *Handler) handleDisable(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	p, m, apiErr := h.lookupForToggle(name)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	if !p.Enabled {
		httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, false))

		return
	}

	if h.runtime != nil {
		if err := h.runtime.Deactivate(r.Context(), name); err != nil && h.logger != nil {
			h.logger.Error("backend stop failed during disable", "plugin", name, "error", err)
		}
	}

	if apiErr := h.setEnabled(name, false, "disable", "plugin disabled by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin disabled", "plugin", name)
	h.reconcilePermission(name, "plugin disable")
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUpload, p.Approval, false))
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
	err := h.store.Mutate(func(st *state.State) error {
		rec, exists := st.Plugins[name]

		if !exists {
			return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished")
		}

		rec.Enabled = enabled

		st.AppendAudit(action, name, detail)

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update state")
	}

	return nil
}

// handleDeny drops a pending plugin: its staging tree is removed and the record deleted.
func (h *Handler) handleDeny(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	p, ok := h.store.Get(name)

	if !ok {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name))

		return
	}

	if p.Approval != state.ApprovalPending {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+name+" is not pending approval"))

		return
	}

	if err := os.RemoveAll(filepath.Join(h.cfg.StagingDir, name)); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to remove staged plugin"))

		return
	}

	if apiErr := h.dropRecord(name, "deny", "upload denied by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin denied", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true})
}

// handleDelete removes an installed (or still-pending) user plugin and its files.
// Builtins cannot be deleted.
func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	p, ok := h.store.Get(name)

	if !ok {
		if h.isBuiltin(name) {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "builtin plugins cannot be deleted"))

			return
		}

		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name))

		return
	}

	// Stop the backend before removing files. Proceed with delete if cleanup fails.
	dir := h.cfg.UserPluginsDir

	if p.Approval == state.ApprovalPending {
		dir = h.cfg.StagingDir
	} else if m, err := manifest.ValidateV3(p.Manifest); err == nil && m.Backend != nil {
		if h.runtime != nil {
			if stopErr := h.runtime.Deactivate(r.Context(), name); stopErr != nil && h.logger != nil {
				h.logger.Error("backend stop failed during delete", "plugin", name, "error", stopErr)
			}
		}
	}

	if err := os.RemoveAll(filepath.Join(dir, name)); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to remove plugin files"))

		return
	}

	if apiErr := h.dropRecord(name, "delete", "plugin removed by operator; permission grants purged"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin deleted", "plugin", name)
	h.reconcilePermission(name, "plugin delete")
	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true})
}

// dropRecord removes a plugin's state entry and audits the removal.
func (h *Handler) dropRecord(name, action, detail string) *httpx.APIError {
	err := h.store.Mutate(func(st *state.State) error {
		delete(st.Plugins, name)
		delete(st.PermissionGrants, name)
		st.AppendAudit(action, name, detail)

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update state")
	}

	return nil
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
