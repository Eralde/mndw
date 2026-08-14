package mgmt

import (
	"context"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

func (h *Handler) decodeLifecycleName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name, apiErr := decodeName(r)

	if apiErr != nil {
		h.writeLifecycleError(w, apiErr)

		return "", false
	}

	return name, true
}

func (h *Handler) lookupStoredPlugin(name string) (*state.Plugin, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok {
		return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
	}

	return p, nil
}

func (h *Handler) mutateWithAudit(action, name, detail string, mutate func(*state.State) error) *httpx.APIError {
	err := h.store.Mutate(func(st *state.State) error {
		if err := mutate(st); err != nil {
			return err
		}

		st.AppendAudit(action, name, detail)

		return nil
	})
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to update state")
	}

	return nil
}

func (h *Handler) deactivateBackend(ctx context.Context, name, failureMessage string) {
	if h.runtime == nil {
		return
	}

	if err := h.runtime.Deactivate(ctx, name); err != nil && h.logger != nil {
		h.logger.Error(failureMessage, "plugin", name, "error", err)
	}
}

func (h *Handler) writeLifecycleError(w http.ResponseWriter, apiErr *httpx.APIError) {
	httpx.WriteError(w, h.logger, apiErr)
}

func (h *Handler) writeLifecycleJSON(w http.ResponseWriter, status int, value any) {
	httpx.WriteJSON(w, h.logger, status, value)
}
