package mgmt

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/state"
)

func lifecycleError(err error, status int, code, message string) *httpx.APIError {
	if err == nil {
		return nil
	}

	var apiErr *httpx.APIError

	if errors.As(err, &apiErr) {
		return apiErr
	}

	if errors.Is(err, backend.ErrLifecycleConflict) {
		return httpx.NewError(http.StatusConflict, httpx.CodeBackendMaintenance, "plugin lifecycle operation already in progress")
	}

	if serviceCapacityError(err) {
		return httpx.NewError(http.StatusConflict, httpx.CodeServiceCapacityExceeded, "service capacity exceeded")
	}

	return httpx.NewError(status, code, message).WithDetail(err.Error())
}

func stillCurrent(ctx context.Context, ctrl backend.LifecycleControl) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if !ctrl.IsCurrent() {
		return backend.ErrLifecycleConflict
	}

	return nil
}

func (h *pluginsAPI) removePluginFiles(name, path string) error {
	started := time.Now()
	done := make(chan error, 1)

	go func() {
		done <- h.removeAll(path)
	}()

	select {
	case err := <-done:
		h.logger.Info("files removed", "plugin", name, "elapsed", time.Since(started))

		return err
	case <-h.newTimer(h.removalWatchdog):
		h.logger.Warn("removal phase exceeded watchdog", "plugin", name, "elapsed", time.Since(started))

		err := <-done

		h.logger.Info("files removed", "plugin", name, "elapsed", time.Since(started))

		return err
	}
}

func (h *pluginsAPI) removePluginBackups(name string) {
	entries, err := os.ReadDir(h.userPluginsDir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			h.logger.Warn("failed to list plugin backups", "plugin", name, "path", h.userPluginsDir, "error", err)
		}

		return
	}

	prefix := name + ".previous-"

	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}

		path := filepath.Join(h.userPluginsDir, entry.Name())

		if err := h.removePluginFiles(name, path); err != nil {
			h.logger.Warn("failed to remove plugin backup", "plugin", name, "path", path, "error", err)
		}
	}
}

func (h *pluginsAPI) decodeLifecycleName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name, apiErr := decodeName(w, r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return "", false
	}

	return name, true
}

func (h *pluginsAPI) lookupStoredPlugin(name string) (*state.Plugin, *httpx.APIError) {
	p, ok := h.store.Get(name)

	if !ok {
		return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "no such plugin: "+name)
	}

	return p, nil
}

func (h *pluginsAPI) mutateWithAudit(action, name, detail string, mutate func(*state.State) error) *httpx.APIError {
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
