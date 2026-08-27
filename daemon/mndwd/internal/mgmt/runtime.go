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
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "backend runtime is unavailable"))

		return
	}

	plugin, ok := h.resolveRuntimePlugin(name)

	if !ok || plugin.Manifest == nil || plugin.Manifest.Backend == nil || plugin.Manifest.Backend.Kind == nil || *plugin.Manifest.Backend.Kind != manifest.BackendKindService {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "restart applies only to service backends"))

		return
	}

	err := h.executeLifecycle(name, backend.OpRestarting, backend.IntentRun, backend.TerminalRun, backend.FailRestore,
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

	m, err := manifest.Validate(pluginState.Manifest)
	if err != nil {
		return nil, false
	}

	dir := pluginState.ActiveVersionDir

	if dir == "" {
		dir = filepath.Join(h.cfg.UserPluginsDir, name)
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
