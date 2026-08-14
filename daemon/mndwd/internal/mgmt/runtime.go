package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func (h *Handler) handleRuntime(w http.ResponseWriter, _ *http.Request) {
	if h.runtime == nil {
		httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{
			"maxConcurrentExecTotal":     0,
			"maxConcurrentExecPerPlugin": 0,
			"maxSupervisedServices":      0,
			"currentExec":                0,
			"reservedServices":           0,
			"supportedServiceProtocols":  []int{},
		})

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, h.runtime.Limits())
}

func (h *Handler) handleRestart(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	if h.runtime == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "v3 backend runtime is unavailable"))

		return
	}

	plugin, ok := h.resolveRuntimePlugin(name)

	if !ok || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil || *plugin.Manifest.Backend.Kind != manifest.BackendKindService {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "restart applies only to service backends"))

		return
	}

	if err := h.runtime.Restart(r.Context(), name); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeBackendUnavailable, "service restart failed"))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"name": name, "runtime": h.runtime.Status(name)})
}

func (h *Handler) resolveRuntimePlugin(name string) (*registry.Plugin, bool) {
	resolver, ok := h.builtins.(interface {
		Resolve(string) (*registry.Plugin, bool)
	})

	if ok {
		return resolver.Resolve(name)
	}

	pluginState, exists := h.store.Get(name)

	if !exists {
		return nil, false
	}

	m, err := manifest.ValidateV3(pluginState.Manifest)
	if err != nil {
		return nil, false
	}

	return &registry.Plugin{Name: name, Manifest: m, Approval: pluginState.Approval, Enabled: pluginState.Enabled}, true
}

func (h *Handler) activateBackendPlugin(name string, m *manifest.Manifest, dir string, enabled bool) error {
	if h.runtime == nil || m == nil || m.Backend == nil || m.Backend.Kind == nil {
		return nil
	}

	return h.runtime.Activate(context.Background(), &registry.Plugin{
		Name: name, Dir: dir, Manifest: m, Approval: state.ApprovalApproved, Enabled: enabled,
	})
}

func serviceCapacityError(err error) bool {
	return errors.Is(err, backend.ErrServiceCapacityExceeded)
}

func decodeRuntimeResponse(data []byte) (backend.RuntimeStatus, error) {
	var status backend.RuntimeStatus
	err := json.Unmarshal(data, &status)

	return status, err
}
