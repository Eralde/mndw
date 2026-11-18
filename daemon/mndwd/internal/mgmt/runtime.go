package mgmt

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func (h *pluginsAPI) handleRuntime(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, h.logger, http.StatusOK, h.runtime.Limits())
}

func (h *pluginsAPI) handleRestart(w http.ResponseWriter, r *http.Request) {
	name, apiErr := decodeName(w, r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	plugin, ok := h.resolveRuntimePlugin(name)

	if !ok || !plugin.Manifest.IsService() {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "restart applies only to service backends"))

		return
	}

	err := h.runtime.ExecuteLifecycle(name, backend.OpRestarting, backend.IntentRun,
		func(_ context.Context, ctrl backend.LifecycleControl) error {
			if err := ctrl.StopService(); err != nil {
				return err
			}

			return ctrl.StartPlugin(plugin)
		})
	if err != nil {
		httpx.WriteError(w, h.logger, lifecycleError(err, http.StatusBadGateway, httpx.CodeBackendUnavailable, "service restart failed"))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"name": name, "runtime": h.runtime.Status(name)})
}

func (h *pluginsAPI) resolveRuntimePlugin(name string) (*registry.Plugin, bool) {
	if h.runtimeResolver != nil {
		return h.runtimeResolver.Resolve(name)
	}

	pluginState, exists := h.store.Get(name)

	if !exists {
		return nil, false
	}

	m, err := manifest.Validate(pluginState.Manifest)
	if err != nil {
		return nil, false
	}

	dir := pluginState.ActiveVersionDir

	if dir == "" {
		if pluginState.Source == state.SourceBuiltin {
			dir = filepath.Join(h.builtinPluginsDir, name)
		} else {
			dir = filepath.Join(h.userPluginsDir, name)
		}
	}

	return &registry.Plugin{
		Name:           name,
		Dir:            dir,
		Manifest:       m,
		Source:         pluginState.Source,
		Approval:       pluginState.Approval,
		Enabled:        pluginState.Enabled && !pluginState.RemovalPending,
		RemovalPending: pluginState.RemovalPending,
	}, true
}

func serviceCapacityError(err error) bool {
	return errors.Is(err, backend.ErrServiceCapacityExceeded)
}
