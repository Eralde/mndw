package telemetry

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"mndwd/internal/httpx"
)

// sessionRoutePrefix is the authenticated diagnostic session route.
const sessionRoutePrefix = "/api/mndw/telemetry/sessions"

// RegisterSessionRoutes mounts the diagnostic session endpoints. Callers must
// place them behind the existing session verifier middleware.
func RegisterSessionRoutes(mux *http.ServeMux, sessions SessionReader, logger *slog.Logger) {
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
	sessions SessionReader
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

	limit, err := ParseSessionLimit(sessionQuery(r.URL.Query()))
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, err.Error()))
		return
	}

	page, err := h.sessions.Read(r.Context(), id, r.URL.Query().Get("after"), limit)
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

// sessionQuery drops the session id from consideration and returns the query
// parameters that the sample endpoint accepts.
func sessionQuery(values url.Values) url.Values {
	filtered := url.Values{}
	for _, key := range []string{"limit", "after"} {
		if _, ok := values[key]; ok {
			filtered[key] = values[key]
		}
	}
	return filtered
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
