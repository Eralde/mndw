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

	m, err := manifest.Validate(p.Manifest)
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

	if apiErr := markScriptsExecutable(installPath, m); apiErr != nil {
		h.rollbackInstall(name, installPath, stagingPath)
		return nil, apiErr
	}

	daemonStarted := false
	if m.Backend != nil && m.Backend.Daemon != nil {
		if err := h.life.Start(name, installPath, m.Backend.Daemon.Start); err != nil {
			h.rollbackInstall(name, installPath, stagingPath)
			return nil, httpx.NewError(http.StatusBadGateway, httpx.CodeDaemonFailed, "failed to start plugin backend daemon")
		}
		daemonStarted = true
	}

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
		h.rollbackApproval(name, installPath, stagingPath, daemonStarted)
		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record approval")
	}

	return m, nil
}

func (h *Handler) rollbackApproval(name, installPath, stagingPath string, daemonStarted bool) {
	if daemonStarted {
		p, ok := h.store.Get(name)
		if ok {
			m, err := manifest.Validate(p.Manifest)
			if err == nil && m.Backend != nil && m.Backend.Daemon != nil {
				if err := h.life.Stop(name, installPath, m.Backend.Daemon.Stop); err != nil {
					h.logger.Error("failed to stop plugin during approval rollback", "plugin", name, "error", err)
				}
			}
		}
	}
	h.rollbackInstall(name, installPath, stagingPath)
}
