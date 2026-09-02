package deviceinfo

import (
	"log/slog"
	"net/http"

	"mndwd/internal/httpx"
)

type Handler struct {
	store  *Store
	logger *slog.Logger
}

func NewHandler(store *Store, logger *slog.Logger) *Handler {
	return &Handler{store: store, logger: logger}
}

func (h *Handler) RegisterProtected(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/device-hardware", h.handleGet)
}

func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	snapshot, err := h.store.Get(r.Context(), r.Header.Get("Cookie"))
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(
			http.StatusBadGateway,
			httpx.CodeBadGateway,
			"Could not read device port information.",
		).WithDetail(err.Error()))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, snapshot)
}
