package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/service"
)

type serviceRequest struct {
	Name string `json:"name"`
}

type serviceEnableRequest struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

func (h *Handler) handleServiceList(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		h.writeServiceError(w, service.ErrServiceUnavailable)

		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), serviceStatusTimeout)

	defer cancel()

	entries, err := h.service.List(ctx)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"services": entries})
}

func (h *Handler) handleServiceStatus(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		h.writeServiceError(w, service.ErrServiceUnavailable)

		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), serviceStatusTimeout)

	defer cancel()

	entry, err := h.service.Status(ctx, r.URL.Query().Get("name"))
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"service": entry})
}

func (h *Handler) handleServiceStart(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "start", func(ctx context.Context, name string) (service.ServiceEntry, error) {
		return h.service.Start(ctx, name)
	})
}

func (h *Handler) handleServiceStop(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "stop", func(ctx context.Context, name string) (service.ServiceEntry, error) {
		return h.service.Stop(ctx, name)
	})
}

func (h *Handler) handleServiceRestart(w http.ResponseWriter, r *http.Request) {
	h.handleServiceAction(w, r, "restart", func(ctx context.Context, name string) (service.ServiceEntry, error) {
		return h.service.Restart(ctx, name)
	})
}

func (h *Handler) handleServiceSetEnabled(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		h.writeServiceError(w, service.ErrServiceUnavailable)

		return
	}

	var req serviceEnableRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeServiceError(w, &service.InvalidServiceError{Name: ""})

		return
	}

	ctx, cancel := context.WithTimeout(h.cfg.ServiceActionRoot, h.cfg.ServiceActionTimeout)

	defer cancel()

	entry, err := h.service.SetEnabled(ctx, req.Name, req.Enabled)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true, "service": entry})
}

func (h *Handler) handleServiceAction(w http.ResponseWriter, r *http.Request, action string, run func(context.Context, string) (service.ServiceEntry, error)) {
	if h.service == nil {
		h.writeServiceError(w, service.ErrServiceUnavailable)

		return
	}

	var req serviceRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeServiceError(w, &service.InvalidServiceError{Name: ""})

		return
	}

	ctx, cancel := context.WithTimeout(h.cfg.ServiceActionRoot, h.cfg.ServiceActionTimeout)

	defer cancel()

	entry, err := run(ctx, req.Name)
	if err != nil {
		h.writeServiceError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true, "service": entry})

	_ = action
}

func (h *Handler) writeServiceError(w http.ResponseWriter, err error) {
	var invalid *service.InvalidServiceError
	var protected *service.ProtectedServiceError
	var pinned *service.EnabledPinnedError
	var failed *service.ActionFailedError
	var timeout *service.ActionTimeoutError

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
	case errors.Is(err, service.ErrServiceUnavailable), errors.Is(err, context.Canceled):
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeServiceUnavailable, "service manager unavailable"))
	default:
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeUnknown, "service operation failed").WithDetail(err.Error()))
	}
}
