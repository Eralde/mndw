package telemetry

import (
	"log/slog"
	"net/http"
	"net/url"

	"mndwd/internal/httpx"
	"mndwd/internal/telemetry/annotations"
)

type Handler struct {
	cache            *SnapshotCache
	gatheringEnabled func() bool
	logger           *slog.Logger
	annotations      *annotations.Store
}

func NewHandler(cache *SnapshotCache, gatheringEnabled func() bool, logger *slog.Logger) *Handler {
	if logger == nil {
		logger = slog.Default()
	}

	return &Handler{cache: cache, gatheringEnabled: gatheringEnabled, logger: logger}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mndw/telemetry", h.handleGet)

	if h.annotations != nil {
		mux.HandleFunc("GET /api/mndw/telemetry/annotations", h.handleAnnotations)
	}
}

func (h *Handler) SetAnnotationStore(store *annotations.Store) {
	h.annotations = store
}

func (h *Handler) handleAnnotations(w http.ResponseWriter, _ *http.Request) {
	if h.annotations == nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "telemetry annotations are unavailable"))

		return
	}

	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"collections": h.annotations.Collections()})
}

func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	query, parseErr := url.ParseQuery(r.URL.RawQuery)

	if parseErr != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "malformed query string"))

		return
	}

	projectValues := query["project"]
	projected := len(projectValues) > 0
	var rangeMs int64

	if projected {
		if len(projectValues) != 1 {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "project must appear at most once"))

			return
		}

		var ok bool
		rangeMs, ok = parseProjectRange(projectValues[0])

		if !ok {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "project must be one of: 1h, 3h, 1d, 7d, 30d"))

			return
		}
	}

	enabled := h.gatheringEnabled != nil && h.gatheringEnabled()
	snapshot, err := h.cache.Get(r.Context(), enabled)
	if err != nil {
		status := http.StatusServiceUnavailable

		httpx.WriteError(w, h.logger, httpx.NewError(status, httpx.CodeBackendUnavailable, "telemetry history is unavailable"))

		return
	}

	w.Header().Set("Cache-Control", "no-store")

	if projected {
		httpx.WriteJSON(w, h.logger, http.StatusOK, projectSnapshot(snapshot, rangeMs))
	} else {
		httpx.WriteJSON(w, h.logger, http.StatusOK, snapshot)
	}
}

func parseProjectRange(value string) (int64, bool) {
	switch value {
	case "1h":
		return 60 * 60 * 1000, true
	case "3h":
		return 3 * 60 * 60 * 1000, true
	case "1d":
		return 24 * 60 * 60 * 1000, true
	case "7d":
		return 7 * 24 * 60 * 60 * 1000, true
	case "30d":
		return 30 * 24 * 60 * 60 * 1000, true
	default:
		return 0, false
	}
}
