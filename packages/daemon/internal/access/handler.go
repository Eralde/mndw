package access

import (
	"encoding/json"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

type Handler struct {
	store *state.Store
}

func New(store *state.Store) *Handler { return &Handler{store: store} }

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/mndw/extender-access", h.handle)
}

func (h *Handler) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Mndw-Csrf") != "1" {
		httpx.WriteError(w, nil, httpx.NewError(http.StatusForbidden, httpx.CodeCsrfRequired, "CSRF header required"))
		return
	}
	switch r.Method {
	case http.MethodGet:
		httpx.WriteJSON(w, nil, http.StatusOK, map[string]bool{"enabled": h.store.Snapshot().ExtenderAccessEnabled})
	case http.MethodPut:
		var request struct {
			Enabled *bool `json:"enabled"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		if err := decoder.Decode(&request); err != nil || request.Enabled == nil {
			httpx.WriteError(w, nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "enabled must be boolean"))
			return
		}
		if err := h.store.Mutate(func(next *state.State) error {
			next.ExtenderAccessEnabled = *request.Enabled
			return nil
		}); err != nil {
			httpx.WriteError(w, nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to save extender access"))
			return
		}
		httpx.WriteJSON(w, nil, http.StatusOK, map[string]bool{"enabled": *request.Enabled})
	default:
		w.Header().Set("Allow", "GET, PUT")
		httpx.WriteError(w, nil, httpx.NewError(http.StatusMethodNotAllowed, httpx.CodeMethodNotAllowed, "method not allowed"))
	}
}
