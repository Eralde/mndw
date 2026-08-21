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
		h.writeOpkgError(w, "failed to list installed packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *Handler) handleOpkgListAvailable(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	packages, err := h.opkg.ListAvailable(ctx)
	if err != nil {
		h.writeOpkgError(w, "failed to list available packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *Handler) handleOpkgList(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext()

	defer cancel()

	result, err := h.opkg.List(ctx)
	if err != nil {
		h.writeOpkgError(w, "failed to list packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, result)
}

func (h *Handler) handleOpkgInfo(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	ctx, cancel := opkgContext()
	defer cancel()
	info, err := h.opkg.Info(ctx, name)
	if err != nil {
		var invalid *opkg.InvalidPackageError
		var notFound *opkg.PackageNotFoundError
		switch {
		case errors.As(err, &invalid):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidPackageName, invalid.Error()))
		case errors.As(err, &notFound):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, notFound.Error()))
		default:
			h.writeOpkgError(w, "failed to read package info", err)
		}
		return
	}
	httpx.WriteJSON(w, h.logger, http.StatusOK, info)
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
		h.writeOpkgError(w, "failed to refresh package metadata", err)

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
		var protected *opkg.ProtectedPackageError

		switch {
		case errors.As(err, &invalid):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidPackageName, "invalid package name: "+invalid.Name))

			return
		case errors.As(err, &protected):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusForbidden, httpx.CodeProtectedPackage, protected.Error()))

			return
		}

		h.writeOpkgError(w, "opkg "+action+" failed", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{
		"ok":       true,
		"message":  opkgActionMessage(action, len(req.Packages)),
		"packages": req.Packages,
	})
}

func (h *Handler) writeOpkgError(w http.ResponseWriter, message string, err error) {
	status := http.StatusBadGateway
	code := httpx.CodeOpkgFailed
	if errors.Is(err, opkg.ErrOpkgUnavailable) {
		status = http.StatusServiceUnavailable
		code = httpx.CodeOpkgUnavailable
	}
	httpx.WriteError(w, h.logger, httpx.NewError(status, code, message).WithDetail(err.Error()))
}
