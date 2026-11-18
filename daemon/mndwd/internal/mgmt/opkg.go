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

func (h *opkgAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mgmt/opkg/list-installed", h.handleOpkgListInstalled)
	mux.HandleFunc("GET /api/mgmt/opkg/list-available", h.handleOpkgListAvailable)
	mux.HandleFunc("GET /api/mgmt/opkg/list", h.handleOpkgList)
	mux.HandleFunc("GET /api/mgmt/opkg/info", h.handleOpkgInfo)
	mux.HandleFunc("POST /api/mgmt/opkg/install", h.handleOpkgInstall)
	mux.HandleFunc("POST /api/mgmt/opkg/remove", h.handleOpkgRemove)
	mux.HandleFunc("POST /api/mgmt/opkg/update", h.handleOpkgUpdate)
	mux.HandleFunc("POST /api/mgmt/opkg/upgrade", h.handleOpkgUpgrade)
}

func (h *opkgAPI) handleOpkgListInstalled(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	packages, err := h.manager.ListInstalled(ctx)
	if err != nil {
		h.writeOpkgError(w, "failed to list installed packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *opkgAPI) handleOpkgListAvailable(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	packages, err := h.manager.ListAvailable(ctx)
	if err != nil {
		h.writeOpkgError(w, "failed to list available packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"packages": packages})
}

func (h *opkgAPI) handleOpkgList(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	result, err := h.manager.List(ctx)
	if err != nil {
		h.writeOpkgError(w, "failed to list packages", err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, result)
}

func (h *opkgAPI) handleOpkgInfo(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	info, err := h.manager.Info(ctx, name)
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

func (h *opkgAPI) handleOpkgInstall(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "install", func(ctx context.Context, pkgs []string) error {
		return h.manager.Install(ctx, pkgs)
	})
}

func (h *opkgAPI) handleOpkgRemove(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "remove", func(ctx context.Context, pkgs []string) error {
		return h.manager.Remove(ctx, pkgs)
	})
}

func (h *opkgAPI) handleOpkgUpgrade(w http.ResponseWriter, r *http.Request) {
	h.opkgMutate(w, r, "upgrade", func(ctx context.Context, pkgs []string) error {
		return h.manager.Upgrade(ctx, pkgs)
	})
}

func (h *opkgAPI) handleOpkgUpdate(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	if err := h.manager.Update(ctx); err != nil {
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
func (h *opkgAPI) opkgMutate(w http.ResponseWriter, r *http.Request, action string, run func(context.Context, []string) error) {
	var req packagesRequest

	defer r.Body.Close()

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be JSON with a packages array"))

		return
	}

	if len(req.Packages) == 0 {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "packages must be a non-empty array"))

		return
	}

	ctx, cancel := opkgContext(h.actionRoot)

	defer cancel()

	if err := run(ctx, req.Packages); err != nil {
		var invalid *opkg.InvalidPackageError
		var protected *opkg.ProtectedPackageError
		var conflict *opkg.DependencyConflictError

		switch {
		case errors.As(err, &invalid):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidPackageName, "invalid package name: "+invalid.Name))

			return
		case errors.As(err, &protected):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusForbidden, httpx.CodeProtectedPackage, protected.Error()))

			return
		case errors.As(err, &conflict):
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeDependencyConflict, conflict.Error()).
				WithDetail(map[string]any{"package": conflict.Package, "dependents": conflict.DependedBy}))

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

func (h *opkgAPI) writeOpkgError(w http.ResponseWriter, message string, err error) {
	status := http.StatusBadGateway
	code := httpx.CodeOpkgFailed

	switch {
	case errors.Is(err, opkg.ErrBusy):
		status = http.StatusConflict
		code = httpx.CodeOpkgBusy
	case errors.Is(err, opkg.ErrOpkgUnavailable):
		status = http.StatusServiceUnavailable
		code = httpx.CodeOpkgUnavailable
	}

	httpx.WriteError(w, h.logger, httpx.NewError(status, code, message).WithDetail(err.Error()))
}
