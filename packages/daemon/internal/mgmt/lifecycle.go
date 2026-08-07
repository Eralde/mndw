package mgmt

import (
	"net/http"
	"os"
	"path/filepath"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

// handleApprove promotes a pending backend plugin: install opkg
// dependencies, move staging → user-plugins, +x declared scripts, start the
// backend.daemon, then record approved+enabled. Dependencies install first (before
// any file move) so an opkg failure leaves the plugin cleanly pending; a failure
// after the move rolls the files back to staging so a retry is possible.
func (h *Handler) handleApprove(w http.ResponseWriter, r *http.Request) {
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

	m, err := manifest.Validate(p.Manifest)
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid"))

		return
	}

	// 1. opkg dependencies (before any file move — failure leaves plugin pending).
	if apiErr := h.installDeps(m); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	// 2. move staging → user-plugins.
	stagingPath := filepath.Join(h.cfg.StagingDir, name)
	installPath := filepath.Join(h.cfg.UserPluginsDir, name)
	if err := moveDir(stagingPath, installPath); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin"))

		return
	}

	// 3. +x declared scripts; roll back the move on failure.
	if apiErr := markScriptsExecutable(installPath, m); apiErr != nil {
		h.rollbackInstall(name, installPath, stagingPath)
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	// 4. start backend.daemon; roll back on failure.
	if m.Backend != nil && m.Backend.Daemon != nil {
		if err := h.life.Start(name, installPath, m.Backend.Daemon.Start); err != nil {
			h.rollbackInstall(name, installPath, stagingPath)
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeDaemonFailed, "failed to start plugin backend daemon"))

			return
		}
	}

	// 5. record approved + enabled.
	err = h.store.Mutate(func(st *state.State) error {
		rec, exists := st.Plugins[name]
		if !exists {
			return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished during approval")
		}
		rec.Approval = state.ApprovalApproved
		rec.Enabled = true
		st.AppendAudit("approve", name, "backend approved and activated")

		return nil
	})
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record approval"))

		return
	}

	h.logger.Info("plugin approved", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUser, state.ApprovalApproved, true))
}

// installDeps installs a plugin's declared opkg packages. No-op when none declared.
func (h *Handler) installDeps(m *manifest.Manifest) *httpx.APIError {
	if m.Backend == nil || len(m.Backend.Opkg) == 0 {
		return nil
	}

	ctx, cancel := opkgContext()
	defer cancel()

	if err := h.opkg.Install(ctx, m.Backend.Opkg); err != nil {
		h.logger.Error("opkg dependency install failed", "plugin", deref(m.Name), "packages", m.Backend.Opkg, "error", err)

		return httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to install plugin dependencies")
	}

	return nil
}

// rollbackInstall best-effort returns an install back to staging so a failed approval
// can be retried after the operator fixes the cause.
func (h *Handler) rollbackInstall(name, installPath, stagingPath string) {
	if err := moveDir(installPath, stagingPath); err != nil {
		h.logger.Error("failed to roll back plugin install to staging", "plugin", name, "error", err)
	}
}

// handleEnable re-activates a disabled (approved) plugin: start its daemon and mark
// enabled. Idempotent when already enabled.
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
		httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUser, p.Approval, true))

		return
	}

	installPath := filepath.Join(h.cfg.UserPluginsDir, name)
	if m.Backend != nil && m.Backend.Daemon != nil {
		if err := h.life.Start(name, installPath, m.Backend.Daemon.Start); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeDaemonFailed, "failed to start plugin backend daemon"))

			return
		}
	}

	if apiErr := h.setEnabled(name, true, "enable", "plugin enabled by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin enabled", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUser, state.ApprovalApproved, true))
}

// handleDisable deactivates a plugin: stop its daemon and mark disabled. Routes are
// gated on the enabled flag, so disabling immediately kills dispatch + ws access.
// Idempotent when already disabled. A stop-hook failure still disables (routes off)
// and is logged — a lingering process must not block the state change.
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
		httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUser, p.Approval, false))

		return
	}

	installPath := filepath.Join(h.cfg.UserPluginsDir, name)
	if m.Backend != nil && m.Backend.Daemon != nil {
		if err := h.life.Stop(name, installPath, m.Backend.Daemon.Stop); err != nil {
			h.logger.Error("daemon stop hook failed during disable", "plugin", name, "error", err)
		}
	}

	if apiErr := h.setEnabled(name, false, "disable", "plugin disabled by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin disabled", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, state.SourceUser, p.Approval, false))
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

	m, err := manifest.Validate(p.Manifest)
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

	// Stop the backend.daemon before removing files (best-effort — proceed with the
	// delete even if the stop hook fails, and log it).
	dir := h.cfg.UserPluginsDir
	if p.Approval == state.ApprovalPending {
		dir = h.cfg.StagingDir
	} else if m, err := manifest.Validate(p.Manifest); err == nil && m.Backend != nil && m.Backend.Daemon != nil {
		if stopErr := h.life.Stop(name, filepath.Join(dir, name), m.Backend.Daemon.Stop); stopErr != nil {
			h.logger.Error("daemon stop hook failed during delete", "plugin", name, "error", stopErr)
		}
	}
	if err := os.RemoveAll(filepath.Join(dir, name)); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to remove plugin files"))

		return
	}

	if apiErr := h.dropRecord(name, "delete", "plugin removed by operator"); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	h.logger.Info("plugin deleted", "plugin", name)
	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true})
}

// dropRecord removes a plugin's state entry and audits the removal.
func (h *Handler) dropRecord(name, action, detail string) *httpx.APIError {
	err := h.store.Mutate(func(st *state.State) error {
		delete(st.Plugins, name)
		st.AppendAudit(action, name, detail)

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update state")
	}

	return nil
}

// markScriptsExecutable applies +x to every declared backend script and daemon hook.
// A declared-but-absent file is a packaging error and fails approval.
func markScriptsExecutable(installPath string, m *manifest.Manifest) *httpx.APIError {
	if m.Backend == nil {
		return nil
	}

	paths := make([]string, 0)
	for _, s := range m.Backend.Scripts {
		paths = append(paths, s.Source)
	}
	if m.Backend.Daemon != nil {
		paths = append(paths, m.Backend.Daemon.Start, m.Backend.Daemon.Stop)
	}

	for _, rel := range paths {
		abs, err := safeJoin(installPath, rel)
		if err != nil {
			return httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "script path escapes plugin dir: "+rel)
		}
		if err := chmodExecutable(abs); err != nil {
			return httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "declared script missing or unreadable: "+rel)
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
