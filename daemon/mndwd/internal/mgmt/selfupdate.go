package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/opkg"
	"mndwd/internal/selfupdate"
)

func (h *Handler) handleSelfUpdateStatus(w http.ResponseWriter, _ *http.Request) {
	if h.selfUpdate == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	status, err := h.selfUpdate.Status()
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, status)
}

func (h *Handler) handleSelfUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r) {
		return
	}

	if h.selfUpdate == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := h.opkgContext()

	defer cancel()

	result, err := h.selfUpdate.Check(ctx)
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, result)
}

func (h *Handler) handleSelfUpdateApply(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r) {
		return
	}

	if h.selfUpdate == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := h.opkgContext()

	defer cancel()

	h.handleSelfUpdateAction(w, ctx, h.selfUpdate.BeginUpdate)
}

func (h *Handler) handleSelfUpdateRevert(w http.ResponseWriter, r *http.Request) {
	if !decodeSelfUpdateEmptyObject(w, r) {
		return
	}

	if h.selfUpdate == nil {
		h.writeSelfUpdateError(w, errors.New("self-update service unavailable"))

		return
	}

	ctx, cancel := h.opkgContext()

	defer cancel()

	h.handleSelfUpdateAction(w, ctx, h.selfUpdate.BeginRevert)
}

func (h *Handler) handleSelfUpdateAction(w http.ResponseWriter, ctx context.Context, action func(context.Context) (selfupdate.Accepted, error)) {
	accepted, err := action(ctx)
	if err != nil {
		h.writeSelfUpdateError(w, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusAccepted, accepted)
}

func decodeSelfUpdateEmptyObject(w http.ResponseWriter, r *http.Request) bool {
	var object map[string]json.RawMessage
	decoder := json.NewDecoder(r.Body)

	if err := decoder.Decode(&object); err != nil || object == nil {
		httpx.WriteError(w, nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be an empty JSON object"))

		return false
	}

	if len(object) != 0 {
		httpx.WriteError(w, nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be an empty JSON object"))

		return false
	}

	var extra any

	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.WriteError(w, nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be one empty JSON object"))

		return false
	}

	return true
}

func (h *Handler) writeSelfUpdateError(w http.ResponseWriter, err error) {
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
