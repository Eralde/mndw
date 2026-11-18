package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/initd"
)

type serviceRequest struct {
	Name string `json:"name"`
}

type serviceEnableRequest struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func (h *serviceAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/service/list", h.handleServiceList)
	mux.HandleFunc("GET /api/mgmt/service/status", h.handleServiceStatus)
	mux.HandleFunc("POST /api/mgmt/service/start", h.handleServiceStart)
	mux.HandleFunc("POST /api/mgmt/service/stop", h.handleServiceStop)
	mux.HandleFunc("POST /api/mgmt/service/restart", h.handleServiceRestart)
	mux.HandleFunc("POST /api/mgmt/service/set-enabled", h.handleServiceSetEnabled)
}

func (h *serviceAPI) handleServiceList(w http.ResponseWriter, r *http.Request) {
	if h.manager == nil {
		h.writeServiceError(w, initd.ErrServiceUnavailable)

		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), serviceStatusTimeout)

	defer cancel()

	entries, err := h.manager.List(ctx)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"services": entries})
}

func (h *serviceAPI) handleServiceStatus(w http.ResponseWriter, r *http.Request) {
	if h.manager == nil {
		h.writeServiceError(w, initd.ErrServiceUnavailable)

		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), serviceStatusTimeout)

	defer cancel()

	entry, err := h.manager.Status(ctx, r.URL.Query().Get("name"))
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"service": entry})
}

func (h *serviceAPI) handleServiceStart(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "start", func(ctx context.Context, name string) (initd.ServiceEntry, error) {
		return h.manager.Start(ctx, name)
	})
}

func (h *serviceAPI) handleServiceStop(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "stop", func(ctx context.Context, name string) (initd.ServiceEntry, error) {
		return h.manager.Stop(ctx, name)
	})
}

func (h *serviceAPI) handleServiceRestart(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "restart", func(ctx context.Context, name string) (initd.ServiceEntry, error) {
		return h.manager.Restart(ctx, name)
	})
}

func (h *serviceAPI) handleServiceSetEnabled(w http.ResponseWriter, r *http.Request) {
	if h.manager == nil {
		h.writeServiceError(w, initd.ErrServiceUnavailable)

		return
	}

	var req serviceEnableRequest

	defer r.Body.Close()

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeServiceError(w, &initd.InvalidServiceError{Name: ""})

		return
	}

	ctx, cancel := context.WithTimeout(h.actionRoot, h.actionTimeout)

	defer cancel()

	entry, err := h.manager.SetEnabled(ctx, req.Name, req.Enabled)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true, "service": entry})
}

func (h *serviceAPI) handleServiceAction(w http.ResponseWriter, r *http.Request, action string, run func(context.Context, string) (initd.ServiceEntry, error)) {
	if h.manager == nil {
		h.writeServiceError(w, initd.ErrServiceUnavailable)

		return
	}

	var req serviceRequest

	defer r.Body.Close()

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeServiceError(w, &initd.InvalidServiceError{Name: ""})

		return
	}

	ctx, cancel := context.WithTimeout(h.actionRoot, h.actionTimeout)

	defer cancel()

	entry, err := run(ctx, req.Name)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true, "service": entry})

	_ = action
}

func (h *serviceAPI) writeServiceError(w http.ResponseWriter, err error) {
	var invalid *initd.InvalidServiceError
	var protected *initd.ProtectedServiceError
	var pinned *initd.EnabledPinnedError
	var failed *initd.ActionFailedError
	var timeout *initd.ActionTimeoutError

	switch {
	case errors.As(err, &invalid):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidServiceName, invalid.Error()))
	case errors.As(err, &protected):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusForbidden, httpx.CodeProtectedService, protected.Error()))
	case errors.As(err, &pinned):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, pinned.Error()))
	case errors.As(err, &failed):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeActionFailed, failed.Error()))
	case errors.As(err, &timeout), errors.Is(err, context.DeadlineExceeded):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusGatewayTimeout, httpx.CodeActionTimeout, "service action timed out"))
	case errors.Is(err, initd.ErrServiceUnavailable), errors.Is(err, context.Canceled):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeServiceUnavailable, "service manager unavailable"))
	default:
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeUnknown, "service operation failed").WithDetail(err.Error()))
	}
}
