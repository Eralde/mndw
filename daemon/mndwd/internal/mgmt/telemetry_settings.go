package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

type TelemetryController interface {
	IsEnabled() bool
	SetEnabled(context.Context, bool) error
}

type TelemetrySession interface {
	AuthModeKnown() bool
	SessionPresent() bool
	SubscribeMutations(func()) func()
}

type telemetrySettingsDTO struct {
	Enabled bool `json:"enabled"`
}

const telemetrySessionLossDetail = "disabled: background router access removed"

func (h *telemetryAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/telemetry", h.handleTelemetryGet)
	mux.HandleFunc("PUT /api/mgmt/telemetry", h.handleTelemetryPut)
}

func (h *telemetryAPI) handleTelemetryGet(w http.ResponseWriter, _ *http.Request) {
	enabled := h.store.Snapshot().Settings.BackgroundTelemetry

	httpx.WriteJSON(w, h.logger, http.StatusOK, telemetrySettingsDTO{Enabled: enabled})
}

func (h *telemetryAPI) handleTelemetryPut(w http.ResponseWriter, r *http.Request) {
	if !httpx.RequireCSRF(w, h.logger, r) {
		return
	}

	if h.controller == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(
			http.StatusServiceUnavailable, httpx.CodeInternal, "telemetry is unavailable",
		))

		return
	}

	var incoming telemetrySettingsDTO

	r.Body = http.MaxBytesReader(w, r.Body, 1024)

	defer r.Body.Close()

	decoder := json.NewDecoder(r.Body)

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&incoming); err != nil {
		h.writeTelemetryDecodeError(w, err)

		return
	}

	var trailing any

	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		h.writeTelemetryDecodeError(w, err)

		return
	}

	if err := h.transition(incoming.Enabled, telemetryAuditDetail(incoming.Enabled)); err != nil {
		httpx.WriteError(w, h.logger, err)

		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *telemetryAPI) transition(enabled bool, detail string) *httpx.APIError {
	h.mu.Lock()

	defer h.mu.Unlock()

	if enabled && (h.session == nil || !h.session.SessionPresent()) {
		return httpx.NewError(http.StatusConflict, httpx.CodeConflict, "background router access is required for telemetry")
	}

	oldEnabled := h.store.Snapshot().Settings.BackgroundTelemetry

	if oldEnabled == enabled {
		return nil
	}

	transitionCtx, cancel := context.WithTimeout(h.actionRoot, serviceActionTimeout)

	defer cancel()

	if err := h.controller.SetEnabled(transitionCtx, enabled); err != nil {
		if rollbackErr := h.controller.SetEnabled(transitionCtx, oldEnabled); rollbackErr != nil {
			h.logger.Error("telemetry runtime rollback failed", "error", rollbackErr)
		}

		return httpx.NewError(http.StatusBadGateway, httpx.CodeBackendUnavailable, "could not change telemetry gathering")
	}

	if err := h.store.Mutate(func(st *state.State) error {
		st.Settings.BackgroundTelemetry = enabled

		st.AppendAudit("telemetry", "", detail)

		return nil
	}); err != nil {
		if rollbackErr := h.controller.SetEnabled(transitionCtx, oldEnabled); rollbackErr != nil {
			h.logger.Error("telemetry rollback failed", "error", rollbackErr)
		}

		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "could not save telemetry setting")
	}

	h.events.publish("telemetry.gathering_changed", func(publisher ManagementEventPublisher) error {
		return publisher.PublishTelemetryGatheringChanged(contractEvents.TelemetryGatheringChangedPayload{Enabled: enabled})
	})

	return nil
}

func telemetryAuditDetail(enabled bool) string {
	if enabled {
		return "enabled"
	}

	return "disabled"
}

func (h *telemetryAPI) watchSessionLoss(ctx context.Context) {
	if ctx == nil || ctx.Err() != nil || h.session == nil || h.controller == nil {
		return
	}

	changes := make(chan struct{}, 1)
	wake := func() {
		select {
		case changes <- struct{}{}:
		default:
		}
	}

	unsubscribe := h.session.SubscribeMutations(wake)

	wake()

	go func() {
		defer unsubscribe()

		for {
			select {
			case <-ctx.Done():
				return
			case <-changes:
				if !h.session.AuthModeKnown() || h.session.SessionPresent() {
					continue
				}

				if err := h.transition(false, telemetrySessionLossDetail); err != nil {
					h.logger.Error("could not disable telemetry after background router access was removed", "error", err)
				}
			}
		}
	}()
}

func (h *telemetryAPI) writeTelemetryDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError

	if errors.As(err, &tooLarge) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeBodyTooLarge, "request body is too large"))

		return
	}

	httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid telemetry settings"))
}
