package mgmt

import (
	"context"
	"errors"
	"net/http"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type localLifecycleControl struct{}

func (localLifecycleControl) StartPlugin(*registry.Plugin) error { return nil }

func (localLifecycleControl) StopService() error { return nil }

func (localLifecycleControl) IsCurrent() bool { return true }

func (localLifecycleControl) Generation() uint64 { return 0 }

func (h *Handler) executeLifecycle(
	name string,
	op backend.Operation,
	intent backend.Intent,
	work func(context.Context, backend.LifecycleControl) error,
) error {
	if h.runtime == nil {
		return work(h.cfg.ServiceActionRoot, localLifecycleControl{})
	}

	return h.runtime.ExecuteLifecycle(name, op, intent, work)
}

func lifecycleError(err error, status int, code, message string) *httpx.APIError {
	if err == nil {
		return nil
	}

	var apiErr *httpx.APIError

	if errors.As(err, &apiErr) {
		return apiErr
	}

	if errors.Is(err, backend.ErrLifecycleConflict) {
		return httpx.NewError(http.StatusConflict, httpx.CodeBackendMaintenance, "plugin lifecycle operation already in progress")
	}

	if serviceCapacityError(err) {
		return httpx.NewError(http.StatusConflict, httpx.CodeServiceCapacityExceeded, "service capacity exceeded")
	}

	return httpx.NewError(status, code, message).WithDetail(err.Error())
}

func (h *Handler) removePluginFiles(name, path string) error {
	started := time.Now()
	done := make(chan error, 1)

	go func() {
		done <- h.removeAll(path)
	}()

	select {
	case err := <-done:
		if h.logger != nil {
			h.logger.Info("files removed", "plugin", name, "elapsed", time.Since(started))
		}

		return err
	case <-h.newTimer(h.removalWatchdog):
		if h.logger != nil {
			h.logger.Warn("removal phase exceeded watchdog", "plugin", name, "elapsed", time.Since(started))
		}

		err := <-done

		if h.logger != nil {
			h.logger.Info("files removed", "plugin", name, "elapsed", time.Since(started))
		}

		return err
	}
}

func (h *Handler) decodeLifecycleName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return "", false
	}

	return name, true
}

func (h *Handler) lookupStoredPlugin(name string) (*state.Plugin, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok {
		return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
	}

	return p, nil
}

func (h *Handler) mutateWithAudit(action, name, detail string, mutate func(*state.State) error) *httpx.APIError {
	err := h.store.Mutate(func(st *state.State) error {
		if err := mutate(st); err != nil {
			return err
		}

		st.AppendAudit(action, name, detail)

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update state")
	}

	return nil
}

func (h *Handler) writeLifecycleError(w http.ResponseWriter, apiErr *httpx.APIError) {
	httpx.WriteError(w, h.logger, apiErr)
}

func (h *Handler) writeLifecycleJSON(w http.ResponseWriter, status int, value any) {
	httpx.WriteJSON(w, h.logger, status, value)
}
