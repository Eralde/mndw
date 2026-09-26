package sessions

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"mndwd/internal/httpx"
)

// sessionRoutePrefix is the authenticated diagnostic session route.
const sessionRoutePrefix = "/api/mndw/telemetry/sessions"

// RegisterRoutes mounts the diagnostic session endpoints. Callers must
// place them behind the existing session verifier middleware.
func RegisterRoutes(mux *http.ServeMux, sessions Reader, logger *slog.Logger) {
	if sessions == nil {
		return
	}

	if logger == nil {
		logger = slog.Default()
	}

	handler := &sessionHandler{sessions: sessions, logger: logger}

	mux.HandleFunc("GET "+sessionRoutePrefix, handler.handleList)
	mux.HandleFunc("GET "+sessionRoutePrefix+"/{id}", handler.handleRead)
}

type sessionHandler struct {
	sessions Reader
	logger   *slog.Logger
}

func (h *sessionHandler) handleList(w http.ResponseWriter, r *http.Request) {
	if err := requireNoQuery(r.URL.Query()); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, err.Error()))

		return
	}

	list, err := h.sessions.List(r.Context())
	if err != nil {
		// The list endpoint reports availability instead of failing: callers can
		// still see explicit storage status.
		h.logger.Warn("telemetry session list failed", "error", err)
	}

	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, h.logger, http.StatusOK, SessionList{
		Sessions: nonNilSummaries(list.Sessions),
		Storage:  list.Storage,
	})
}

func (h *sessionHandler) handleRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if id == "" {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "session id is required"))

		return
	}

	limit, after, err := parseSessionReadQuery(r.URL.Query())
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, err.Error()))

		return
	}

	page, err := h.sessions.Read(r.Context(), id, after, limit)
	if err != nil {
		switch {
		case errors.Is(err, ErrSessionNotFound):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "session not found"))
		case errors.Is(err, ErrCursorInvalid):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "invalid cursor"))
		case errors.Is(err, ErrCursorExpired):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusGone, httpx.CodeConflict, "cursor expired"))
		case errors.Is(err, ErrSessionUnavailable):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusServiceUnavailable, httpx.CodeBackendUnavailable, "telemetry storage is unavailable"))
		default:
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "session read failed"))
		}

		return
	}

	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, h.logger, http.StatusOK, page)
}

// parseSessionReadQuery validates the sample endpoint parameters while keeping
// cursor values out of ParseSessionLimit's narrower input.
func parseSessionReadQuery(values url.Values) (int, string, error) {
	for key := range values {
		if key != "limit" && key != "after" {
			return 0, "", errors.New("telemetry: unknown query parameter")
		}
	}

	if len(values["after"]) > 1 {
		return 0, "", errors.New("telemetry: after must be supplied once")
	}

	limitValues := url.Values{}
	if limit, ok := values["limit"]; ok {
		limitValues["limit"] = limit
	}

	limit, err := ParseSessionLimit(limitValues)
	if err != nil {
		return 0, "", err
	}

	return limit, values.Get("after"), nil
}

// requireNoQuery rejects unknown query parameters on the list endpoint.
func requireNoQuery(values url.Values) error {
	if len(values) == 0 {
		return nil
	}

	return errors.New("telemetry session list accepts no query parameters")
}

func nonNilSummaries(sessions []SessionSummary) []SessionSummary {
	if sessions == nil {
		return []SessionSummary{}
	}

	return sessions
}

func nonNilSamples(samples []SessionSample) []SessionSample {
	if samples == nil {
		return []SessionSample{}
	}

	return samples
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}

	return values
}
