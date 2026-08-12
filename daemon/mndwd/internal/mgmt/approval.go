package mgmt

import (
	"net/http"
	"path/filepath"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

func (h *Handler) executeApprove(name string) (*manifest.Manifest, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok {
		return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
	}

	if p.Approval != state.ApprovalPending {
		return nil, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+name+" is not pending approval")
	}

	m, err := manifest.ValidateV3(p.Manifest)
	if err != nil {
		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid")
	}

	if apiErr := h.installDeps(m); apiErr != nil {
		return nil, apiErr
	}

	stagingPath := filepath.Join(h.cfg.StagingDir, name)
	installPath := filepath.Join(h.cfg.UserPluginsDir, name)

	if err := moveDir(stagingPath, installPath); err != nil {
		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin")
	}

	if apiErr := markCommandsExecutable(installPath, m); apiErr != nil {
		h.rollbackInstall(name, installPath, stagingPath)

		return nil, apiErr
	}

	err = h.store.Mutate(func(st *state.State) error {
		rec, exists := st.Plugins[name]

		if !exists {
			return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished during approval")
		}

		rec.Approval = state.ApprovalApproved
		rec.Enabled = true
		rec.ActiveVersion = deref(m.Version)
		rec.ActiveVersionDir = installPath

		st.AppendAudit("approve", name, "backend approved and activated")

		return nil
	})
	if err != nil {
		h.rollbackInstall(name, installPath, stagingPath)

		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record approval")
	}

	if m.Backend != nil && h.runtime != nil {
		if activationErr := h.activateBackendPlugin(name, m, installPath, true); activationErr != nil && h.logger != nil {
			h.logger.Warn("backend activation deferred after approval", "plugin", name, "error", activationErr)
		}
	}

	return m, nil
}
