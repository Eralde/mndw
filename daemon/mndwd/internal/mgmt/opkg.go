package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"mndwd/internal/httpx"
	"mndwd/internal/opkg"
)

// packagesRequest is the body of install/remove/upgrade: {"packages": ["curl", ...]}.
type packagesRequest struct {
	Packages []string `json:"packages"`
}

func (h *Handler) handleOpkgListInstalled(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	packages, err := h.opkg.ListInstalled(ctx)
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to list installed packages").WithDetail(err.Error()))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *Handler) handleOpkgListAvailable(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	packages, err := h.opkg.ListAvailable(ctx)
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to list available packages").WithDetail(err.Error()))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *Handler) handleOpkgList(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	packages, err := h.opkg.List(ctx)
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to list packages").WithDetail(err.Error()))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *Handler) handleOpkgInstall(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "install", func(ctx context.Context, pkgs []string) error {
		return h.opkg.Install(ctx, pkgs)
	})
}

func (h *Handler) handleOpkgRemove(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "remove", func(ctx context.Context, pkgs []string) error {
		return h.opkg.Remove(ctx, pkgs)
	})
}

func (h *Handler) handleOpkgUpgrade(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "upgrade", func(ctx context.Context, pkgs []string) error {
		return h.opkg.Upgrade(ctx, pkgs)
	})
}

func (h *Handler) handleOpkgUpdate(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	if err := h.opkg.Update(ctx); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "failed to refresh package metadata"))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"ok": true, "message": "Package metadata refreshed"})
}

func opkgActionMessage(action string, count int) string {
	verb := map[string]string{
		"install": "installed",
		"remove":  "removed",
		"upgrade": "upgraded",
	}[action]

	return fmt.Sprintf("%d package(s) %s", count, verb)
}

// opkgMutate runs the shared decode → validate → execute path for install/remove/
// upgrade, mapping opkg's typed errors onto the envelope.
func (h *Handler) opkgMutate(w http.ResponseWriter, r *http.Request, action string, run func(context.Context, []string) error) {
	var req packagesRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be JSON with a packages array"))

		return
	}

	if len(req.Packages) == 0 {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "packages must be a non-empty array"))

		return
	}

	ctx, cancel := opkgContext()

	defer cancel()

	if err := run(ctx, req.Packages); err != nil {
		var invalid *opkg.InvalidPackageError

		if errors.As(err, &invalid) {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidPackageName, "invalid package name: "+invalid.Name))

			return
		}

		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeOpkgFailed, "opkg "+action+" failed"))

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{
		"ok":       true,
		"message":  opkgActionMessage(action, len(req.Packages)),
		"packages": req.Packages,
	})
}
