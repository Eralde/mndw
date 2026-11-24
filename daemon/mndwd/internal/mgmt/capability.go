package mgmt

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

type PersistentRCICapabilityController interface {
	ControllerCapabilityAvailable() bool
	CapabilityChanged(plugin string) error
}

// PersistentRCISocketStartFailure marks an error as a persistent RCI socket start failure.
// Providers implement this interface so management can return the socket-start-specific response.
type PersistentRCISocketStartFailure interface {
	PersistentRCISocketStartFailed() bool
}

func isPersistentRCISocketStartFailure(err error) bool {
	var socketStartFailure PersistentRCISocketStartFailure

	return errors.As(err, &socketStartFailure) && socketStartFailure.PersistentRCISocketStartFailed()
}

type capabilityRequest struct {
	Name       string `json:"name"`
	Capability string `json:"capability"`
	Enabled    *bool  `json:"enabled"`
}

func (h *pluginsAPI) handleCapability(w http.ResponseWriter, r *http.Request) {
	var request capabilityRequest

	defer r.Body.Close()

	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must contain name, capability, and enabled"))

		return
	}

	if request.Name == "" || request.Capability == "" || request.Enabled == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "name, capability, and enabled are required"))

		return
	}

	m, source, approval, enabled, dir, installedAt, apiErr := h.capabilityTarget(request.Name)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	if approval == state.ApprovalPending {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin "+request.Name+" must be approved before changing capabilities"))

		return
	}

	if !manifest.IsPersistentRCICapability(request.Capability) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "capability is unknown"))

		return
	}

	if !declaresCapability(m, request.Capability) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "plugin manifest does not declare capability"))

		return
	}

	if *request.Enabled {
		if h.capabilityController == nil || !h.capabilityController.ControllerCapabilityAvailable() {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeControllerSessionUnavailable, "Controller token session is not available; configure it before enabling persistent RCI."))

			return
		}

		if err := h.store.SetCapabilityGrant(request.Name, request.Capability, true); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update capability grant"))

			return
		}

		if err := h.capabilityController.CapabilityChanged(request.Name); err != nil {
			if isPersistentRCISocketStartFailure(err) {
				httpx.WriteError(w, h.logger, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeRCISocketStartFailed, "Persistent RCI session capability granted, but its socket could not be started."))

				return
			}

			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "capability reconciliation failed"))

			return
		}
	} else {
		if err := h.store.SetCapabilityGrant(request.Name, request.Capability, false); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update capability grant"))

			return
		}

		if h.capabilityController != nil {
			h.reconcileCapability(request.Name, "capability revoke")
		}
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, source, approval, enabled, dir, installedAt))
}

func (h *pluginsAPI) reconcileCapability(plugin, reason string) {
	if h.capabilityController == nil {
		return
	}

	if err := h.capabilityController.CapabilityChanged(plugin); err != nil {
		h.logger.Warn("persistent RCI socket reconciliation failed", "plugin", plugin, "reason", reason)
	}
}

func (h *pluginsAPI) capabilityTarget(name string) (*manifest.Manifest, state.Source, state.Approval, bool, string, time.Time, *httpx.APIError) {
	if plugin, ok := h.store.Get(name); ok {
		if plugin.Source == state.SourceBuiltin {
			builtin, apiErr := h.lookupBuiltin(name)

			if apiErr != nil {
				return nil, "", "", false, "", time.Time{}, apiErr
			}

			if builtin == nil {
				return nil, "", "", false, "", time.Time{}, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
			}

			return builtin.Manifest, state.SourceBuiltin, plugin.Approval, plugin.Enabled, builtin.Dir, plugin.InstalledAt, nil
		}

		m, err := manifest.Validate(plugin.Manifest)
		if err != nil {
			return nil, "", "", false, "", time.Time{}, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "stored manifest is invalid")
		}

		dir := filepath.Join(h.userPluginsDir, name)

		if plugin.Approval == state.ApprovalPending {
			dir = filepath.Join(h.stagingDir, name)
		}

		return m, plugin.Source, plugin.Approval, plugin.Enabled, dir, plugin.InstalledAt, nil
	}

	builtins, err := h.builtins.ListBuiltins()
	if err != nil {
		return nil, "", "", false, "", time.Time{}, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot read builtin plugins dir")
	}

	for _, plugin := range builtins {
		if plugin.Name == name {
			return plugin.Manifest, state.SourceBuiltin, state.ApprovalApproved, true, plugin.Dir, time.Time{}, nil
		}
	}

	return nil, "", "", false, "", time.Time{}, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
}

func declaresCapability(m *manifest.Manifest, capability string) bool {
	for _, declared := range m.Capabilities {
		if declared == capability {
			return true
		}
	}

	return false
}
