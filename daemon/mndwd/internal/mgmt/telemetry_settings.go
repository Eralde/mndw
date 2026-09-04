package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

type TelemetryController interface {
	IsEnabled() bool
	SetEnabled(context.Context, bool) error
}

type telemetrySettingsDTO struct {
	Enabled bool `json:"enabled"`
}

func (h *Handler) handleTelemetryGet(w http.ResponseWriter, _ *http.Request) {
	enabled := h.store.Snapshot().Settings.BackgroundTelemetry

	httpx.WriteJSON(w, h.logger, http.StatusOK, telemetrySettingsDTO{Enabled: enabled})
}

func (h *Handler) handleTelemetryPut(w http.ResponseWriter, r *http.Request) {
	if !httpx.RequireCSRF(w, h.logger, r) {
		return
	}

	if h.telemetry == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(
			http.StatusServiceUnavailable, httpx.CodeInternal, "telemetry is unavailable",
		))

		return
	}

	var incoming telemetrySettingsDTO
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&incoming); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid telemetry settings"))

		return
	}

	var trailing any

	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid telemetry settings"))

		return
	}

	h.telemetryMu.Lock()

	defer h.telemetryMu.Unlock()

	transitionCtx, cancel := context.WithTimeout(h.cfg.ServiceActionRoot, serviceActionTimeout)

	defer cancel()

	oldEnabled := h.store.Snapshot().Settings.BackgroundTelemetry

	if oldEnabled == incoming.Enabled {
		w.WriteHeader(http.StatusNoContent)

		return
	}

	if err := h.telemetry.SetEnabled(transitionCtx, incoming.Enabled); err != nil {
		if rollbackErr := h.telemetry.SetEnabled(transitionCtx, oldEnabled); rollbackErr != nil {
			h.logger.Error("telemetry runtime rollback failed", "error", rollbackErr)
		}

		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeBackendUnavailable, "could not change telemetry gathering"))

		return
	}

	if err := h.store.Mutate(func(st *state.State) error {
		st.Settings.BackgroundTelemetry = incoming.Enabled
		detail := "disabled"

		if incoming.Enabled {
			detail = "enabled"
		}

		st.AppendAudit("telemetry", "", detail)

		return nil
	}); err != nil {
		if rollbackErr := h.telemetry.SetEnabled(transitionCtx, oldEnabled); rollbackErr != nil {
			h.logger.Error("telemetry rollback failed", "error", rollbackErr)
		}

		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "could not save telemetry setting"))

		return
	}

	w.WriteHeader(http.StatusNoContent)
}
