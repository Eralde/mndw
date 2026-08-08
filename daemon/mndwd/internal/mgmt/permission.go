package mgmt

import (
	"encoding/json"
	"errors"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

type PersistentRCIPermissionController interface {
	ControllerPermissionAvailable() bool
	PermissionChanged(plugin string) error
}

var ErrPersistentRCISocketStart = errors.New("persistent RCI socket start failed")

type permissionRequest struct {
	Name       string `json:"name"`
	Permission string `json:"permission"`
	Enabled    *bool  `json:"enabled"`
}

func (h *Handler) handlePermission(w http.ResponseWriter, r *http.Request) {
	var request permissionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must contain name, permission, and enabled"))

		return
	}
	if request.Name == "" || request.Permission == "" || request.Enabled == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "name, permission, and enabled are required"))

		return
	}

	m, source, approval, enabled, apiErr := h.permissionTarget(request.Name)
	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}
	if approval == state.ApprovalPending {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+request.Name+" must be approved before changing permissions"))

		return
	}
	if request.Permission != manifest.PersistentRCISessionPermission {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "permission is unknown"))

		return
	}
	if !declaresPermission(m, request.Permission) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "plugin manifest does not declare permission"))

		return
	}

	if *request.Enabled {
		if h.permissionController == nil || !h.permissionController.ControllerPermissionAvailable() {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeControllerSessionUnavailable, "Controller token session is not available; configure it before enabling persistent RCI."))

			return
		}
		if err := h.store.SetGrant(request.Name, request.Permission, true); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update permission grant"))

			return
		}
		if err := h.permissionController.PermissionChanged(request.Name); err != nil {
			if errors.Is(err, ErrPersistentRCISocketStart) {
				httpx.WriteError(w, h.logger, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeRCISocketStartFailed, "Persistent RCI session permission granted, but its socket could not be started."))

				return
			}
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "permission reconciliation failed"))

			return
		}
	} else {
		if err := h.store.SetGrant(request.Name, request.Permission, false); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update permission grant"))

			return
		}
		if h.permissionController != nil {
			h.reconcilePermission(request.Name, "permission revoke")
		}
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, source, approval, enabled))
}

func (h *Handler) reconcilePermission(plugin, reason string) {
	if h.permissionController == nil {
		return
	}
	if err := h.permissionController.PermissionChanged(plugin); err != nil && h.logger != nil {
		h.logger.Warn("persistent RCI socket reconciliation failed", "plugin", plugin, "reason", reason)
	}
}

func (h *Handler) permissionTarget(name string) (*manifest.Manifest, string, string, bool, *httpx.APIError) {
	if plugin, ok := h.store.Get(name); ok {
		m, err := manifest.ValidateV3(plugin.Manifest)
		if err != nil {
			return nil, "", "", false, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid")
		}

		return m, plugin.Source, plugin.Approval, plugin.Enabled, nil
	}
	builtins, err := h.builtins.ListBuiltinsWithError()
	if err != nil {
		return nil, "", "", false, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot read builtin plugins dir")
	}
	for _, plugin := range builtins {
		if plugin.Name == name {
			return plugin.Manifest, state.SourceBuiltin, state.ApprovalApproved, true, nil
		}
	}

	return nil, "", "", false, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
}

func declaresPermission(m *manifest.Manifest, permission string) bool {
	for _, declared := range m.Permissions {
		if declared == permission {
			return true
		}
	}

	return false
}
