package palette

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"mndwd/internal/httpx"
)

const maxPaletteBytes = 16 << 10

type Handler struct {
	store  *Store
	logger *slog.Logger
}

func NewHandler(store *Store, logger *slog.Logger) *Handler {
	return &Handler{store: store, logger: logger}
}

func (h *Handler) RegisterPublic(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/palette", h.handleGet)
}

func (h *Handler) RegisterProtected(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/mgmt/palette", h.handlePut)
	mux.HandleFunc("DELETE /api/mgmt/palette", h.handleDelete)
}

type getResponse struct {
	Palette *Palette `json:"palette"`
}

func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	stored, ok := h.store.Get()

	if !ok {
		httpx.WriteJSON(w, h.logger, http.StatusOK, getResponse{Palette: nil})

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, getResponse{Palette: &stored})
}

func (h *Handler) handlePut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPaletteBytes)

	var incoming Palette
	decoder := json.NewDecoder(r.Body)

	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&incoming); err != nil {
		writeDecodeError(w, h.logger, err)

		return
	}

	var trailing any

	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = errors.New("trailing JSON data")
		}

		writeDecodeError(w, h.logger, err)

		return
	}

	if err := validate(incoming); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, err.Error()))

		return
	}

	if err := h.store.Set(incoming); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(
			http.StatusInternalServerError, httpx.CodeInternal, "Could not save the palette."))

		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func writeDecodeError(w http.ResponseWriter, logger *slog.Logger, err error) {
	var maxBytes *http.MaxBytesError

	if errors.As(err, &maxBytes) {
		httpx.WriteError(w, logger, httpx.NewError(
			http.StatusBadRequest, httpx.CodeBadRequest, "The palette file is too large."))

		return
	}

	httpx.WriteError(w, logger, httpx.NewError(
		http.StatusBadRequest, httpx.CodeBadRequest, "Invalid palette document: "+err.Error()))
}

func (h *Handler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if err := h.store.Clear(); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(
			http.StatusInternalServerError, httpx.CodeInternal, "Could not reset the palette."))

		return
	}

	w.WriteHeader(http.StatusNoContent)
}
