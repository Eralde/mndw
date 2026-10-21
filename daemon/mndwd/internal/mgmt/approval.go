package mgmt

import (
	"context"
	"net/http"
	"path/filepath"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
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

	stagingPath := filepath.Join(h.cfg.StagingDir, name)
	installPath := filepath.Join(h.cfg.UserPluginsDir, name)
	desired := &registry.Plugin{
		Name: name, Dir: installPath, Manifest: m, Source: p.Source,
		Approval: state.ApprovalApproved, Enabled: true,
	}
	err = h.executeLifecycle(name, backend.OpInstalling, backend.IntentRun,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			if apiErr := h.installDeps(ctx, m); apiErr != nil {
				return apiErr
			}

			if err := moveDir(stagingPath, installPath); err != nil {
				return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin")
			}

			if apiErr := markCommandsExecutable(installPath, m); apiErr != nil {
				h.rollbackInstall(name, installPath, stagingPath)

				return apiErr
			}

			if err := ctrl.StartPlugin(desired); err != nil {
				h.rollbackInstall(name, installPath, stagingPath)

				return err
			}

			if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
				_ = ctrl.StopService()

				h.rollbackInstall(name, installPath, stagingPath)

				if err != nil {
					return err
				}

				return backend.ErrLifecycleConflict
			}

			if err := h.store.Mutate(func(st *state.State) error {
				rec, exists := st.Plugins[name]

				if !exists {
					return httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "plugin vanished during approval")
				}

				rec.Approval = state.ApprovalApproved
				rec.Enabled = true
				rec.RemovalPending = false
				rec.ActiveVersion = deref(m.Version)
				rec.ActiveVersionDir = installPath

				st.AppendAudit("approve", name, "backend approved and activated")

				return nil
			}); err != nil {
				_ = ctrl.StopService()

				h.rollbackInstall(name, installPath, stagingPath)

				return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record approval")
			}

			h.publishPluginInstalled(name, deref(m.Version))
			h.publishPluginApproved(name, deref(m.Version))

			return nil
		})
	if err != nil {
		return nil, lifecycleError(err, http.StatusBadGateway, httpx.CodeBackendUnavailable, "backend activation failed")
	}

	return m, nil
}
