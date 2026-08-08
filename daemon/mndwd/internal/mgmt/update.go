package mgmt

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/state"
)

// handleUpdate installs one validated archive over an existing user plugin. The
// old directory is retained under a versioned backup name until the next update;
// state changes only after the new directory is in place and is restored if the
// service cannot pass its activation gate.
func (h *Handler) handleUpdate(w http.ResponseWriter, r *http.Request) {
	data, apiErr := h.readUploadBody(w, r)
	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "update is not a valid zip archive"))
		return
	}
	manifestBytes, err := readManifestFromZip(zr)
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeManifestMissing, "manifest.json not found at archive root"))
		return
	}
	m, err := manifest.ValidateV3(manifestBytes)
	if err != nil {
		if _, unsupported := err.(*manifest.UnsupportedVersionError); unsupported {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeUnsupportedManifestVersion, "manifest version is not supported"))
			return
		}
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed validation").WithDetail(err.Error()))
		return
	}
	name := deref(m.Name)
	previous, exists := h.store.Get(name)
	if !exists || previous.Source == state.SourceBuiltin {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "updates require an installed user plugin"))
		return
	}
	if previous.Approval != state.ApprovalApproved || !previous.Enabled {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeConflict, "plugin must be approved and enabled before update"))
		return
	}
	if apiErr := h.installDeps(m); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)
		return
	}
	if err := os.MkdirAll(h.cfg.StagingDir, 0o700); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to create update staging directory"))
		return
	}

	updateDir, err := os.MkdirTemp(h.cfg.StagingDir, name+"-update-")
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to create update staging directory"))
		return
	}
	defer os.RemoveAll(updateDir)
	if err := extractZip(zr, updateDir); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "failed to extract update archive"))
		return
	}
	if apiErr := markCommandsExecutable(updateDir, m); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)
		return
	}
	if apiErr := validateV3Commands(updateDir, m); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)
		return
	}

	maintenanceStarted := h.runtime != nil && m.Backend != nil
	if maintenanceStarted {
		if err := h.runtime.BeginPluginMaintenance(r.Context(), name); err != nil {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeBackendUnavailable, "failed to drain plugin backend"))
			return
		}
	}
	if maintenanceStarted {
		defer h.runtime.EndPluginMaintenance(name)
	}

	activeDir := filepath.Join(h.cfg.UserPluginsDir, name)
	backupDir := filepath.Join(h.cfg.UserPluginsDir, name+".previous-"+safeVersion(previous.Version))
	if err := moveDir(activeDir, backupDir); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to retain previous plugin version"))
		return
	}
	if err := moveDir(updateDir, activeDir); err != nil {
		_ = moveDir(backupDir, activeDir)
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to activate update"))
		return
	}

	if err := h.store.Mutate(func(st *state.State) error {
		record := st.Plugins[name]
		if record == nil {
			return fmt.Errorf("plugin state disappeared")
		}
		record.Manifest = append(json.RawMessage(nil), manifestBytes...)
		record.Version = deref(m.Version)
		record.Label = deref(m.Label)
		record.Type = deref(m.Type)
		record.InstalledVersion = deref(m.Version)
		record.ActiveVersion = deref(m.Version)
		record.ActiveVersionDir = activeDir
		record.InstalledAt = time.Now().UTC()
		st.AppendAudit("update", name, "plugin version activated")
		return nil
	}); err != nil {
		_ = moveDir(activeDir, updateDir)
		_ = moveDir(backupDir, activeDir)
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record update"))
		return
	}

	if h.runtime != nil && m.Backend != nil {
		if plugin, ok := h.resolveRuntimePlugin(name); ok {
			if err := h.runtime.Activate(r.Context(), plugin); err != nil {
				if rollbackErr := h.rollbackUpdate(name, previous, activeDir, backupDir, updateDir); rollbackErr != nil && h.logger != nil {
					h.logger.Error("update rollback failed", "plugin", name, "error", rollbackErr)
				}
				httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadGateway, httpx.CodeBackendUnavailable, "updated service failed readiness"))
				return
			}
		}
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, previous.Source, state.ApprovalApproved, true))
}

func safeVersion(version string) string {
	if version == "" {
		return "unknown"
	}
	result := make([]byte, 0, len(version))
	for _, character := range version {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.' {
			result = append(result, byte(character))
		} else {
			result = append(result, '-')
		}
	}
	return string(result)
}

func validateV3Commands(dir string, m *manifest.Manifest) *httpx.APIError {
	if m == nil || m.Backend == nil || m.Backend.Kind == nil {
		return nil
	}
	commands := make([]string, 0, len(m.Backend.Routes)+1)
	if m.Backend.Command != nil {
		commands = append(commands, *m.Backend.Command)
	}
	for _, route := range m.Backend.Routes {
		if route.Command != "" {
			commands = append(commands, route.Command)
		}
	}
	for _, command := range commands {
		if _, err := backend.ValidateCommand(dir, command); err != nil {
			return httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "backend command failed static validation").WithDetail(command)
		}
	}
	return nil
}

func (h *Handler) rollbackUpdate(name string, previous *state.Plugin, activeDir, backupDir, failedDir string) error {
	if h.runtime != nil {
		_ = h.runtime.BeginPluginMaintenance(context.Background(), name)
	}
	if err := moveDir(activeDir, failedDir); err != nil {
		return err
	}
	if err := moveDir(backupDir, activeDir); err != nil {
		return err
	}
	return h.store.Mutate(func(st *state.State) error {
		st.Plugins[name] = previous
		st.AppendAudit("rollback", name, "update readiness failed")
		return nil
	})
}
