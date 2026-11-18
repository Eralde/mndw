package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/opkg"
	"mndwd/internal/selfupdate"
)

func (h *selfUpdateAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/self-update/status", h.handleSelfUpdateStatus)
	mux.HandleFunc("POST /api/mgmt/self-update/check", h.handleSelfUpdateCheck)
	mux.HandleFunc("POST /api/mgmt/self-update/apply", h.handleSelfUpdateApply)
	mux.HandleFunc("POST /api/mgmt/self-update/revert", h.handleSelfUpdateRevert)
}

func (h *selfUpdateAPI) handleSelfUpdateStatus(w http.ResponseWriter, _ *http.Request) {
	if h.service == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	status, err := h.service.Status()
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, status)
}

func (h *selfUpdateAPI) handleSelfUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r, h.logger) {
		return
	}

	if h.service == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	result, err := h.service.Check(ctx)
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, result)
}

func (h *selfUpdateAPI) handleSelfUpdateApply(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r, h.logger) {
		return
	}

	if h.service == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	h.handleSelfUpdateAction(w, ctx, h.service.BeginUpdate)
}

func (h *selfUpdateAPI) handleSelfUpdateRevert(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r, h.logger) {
		return
	}

	if h.service == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	h.handleSelfUpdateAction(w, ctx, h.service.BeginRevert)
}

func (h *selfUpdateAPI) handleSelfUpdateAction(w http.ResponseWriter, ctx context.Context, action func(context.Context) (selfupdate.Accepted, error)) {
	accepted, err := action(ctx)
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusAccepted, accepted)
}

func decodeSelfUpdateEmptyObject(w http.ResponseWriter, r *http.Request, logger *slog.Logger) bool {
	var object map[string]json.RawMessage

	defer r.Body.Close()

	decoder := json.NewDecoder(r.Body)

	if err := decoder.Decode(&object); err != nil {
		httpx.WriteError(w, logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be an empty JSON object"))

		return false
	}

	if object == nil {
		httpx.WriteError(w, logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be an empty JSON object"))

		return false
	}

	if len(object) != 0 {
		httpx.WriteError(w, logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be an empty JSON object"))

		return false
	}

	var extra any

	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.WriteError(w, logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be one empty JSON object"))

		return false
	}

	return true
}

func (h *selfUpdateAPI) writeSelfUpdateError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := httpx.CodeSelfUpdateFailed
	message := "self-update operation failed"

	switch {
	case errors.Is(err, opkg.ErrBusy), errors.Is(err, selfupdate.ErrBusy):
		status = http.StatusConflict
		code = httpx.CodeOpkgBusy
		message = "package manager is busy"
	case errors.Is(err, opkg.ErrNoUpdate):
		status = http.StatusConflict
		code = httpx.CodeSelfUpdateNotAvailable
		message = "no update available"
	case errors.Is(err, selfupdate.ErrNoRollback):
		status = http.StatusConflict
		code = httpx.CodeSelfUpdateRollbackUnavailable
		message = "no rollback available"
	}

	httpx.WriteError(w, h.logger, httpx.NewError(status, code, message).WithDetail(err.Error()))
}
