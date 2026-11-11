package mgmt

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// handleUpdate installs one validated archive over an existing user plugin. The
// old directory is retained under a versioned backup name until the new version
// starts; state changes only after the new directory is in place and is restored
// if the service cannot pass its activation gate.
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

	m, err := manifest.Validate(manifestBytes)
	if err != nil {
		if _, unsupported := err.(*manifest.UnsupportedVersionError); unsupported {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeUnsupportedManifestVersion, "manifest version is not supported"))

			return
		}

		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed validation").WithDetail(err.Error()))

		return
	}

	if err := h.validateCatalogArchive(zr, m); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed catalog validation").WithDetail(err.Error()))

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

	if manifest.HasBackend(m) {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusConflict, httpx.CodeApprovalRequired,
			"updates that declare a backend require approval; delete the plugin and upload the new version"))

		return
	}

	activeDir := filepath.Join(h.cfg.UserPluginsDir, name)
	backupDir := filepath.Join(h.cfg.UserPluginsDir, name+".previous-"+safeVersion(previous.Version))
	err = h.executeLifecycle(name, backend.OpUpdating, backend.IntentRun,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			return h.executeUpdate(ctx, ctrl, name, previous, m, manifestBytes, zr, activeDir, backupDir)
		})
	if err != nil {
		if errors.Is(err, backend.ErrForceStopTerminal) {
			httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal,
				"update failed and automatic rollback failed; plugin is stopped — reinstall required").WithDetail(err.Error()))

			return
		}

		httpx.WriteError(w, h.logger, lifecycleError(err, http.StatusBadGateway, httpx.CodeBackendUnavailable, "updated service failed readiness"))

		return
	}

	h.publishPluginInstalled(name, deref(m.Version))

	httpx.WriteJSON(w, h.logger, http.StatusOK, h.entryFrom(m, previous.Source, state.ApprovalApproved, true, activeDir))
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

func validateCommands(dir string, m *manifest.Manifest) *httpx.APIError {
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

func (h *Handler) executeUpdate(
	ctx context.Context,
	ctrl backend.LifecycleControl,
	name string,
	previous *state.Plugin,
	m *manifest.Manifest,
	manifestBytes []byte,
	zr *zip.Reader,
	activeDir string,
	backupDir string,
) error {
	oldMoved := false
	newMoved := false
	stateChanged := false
	var updateDir string

	fail := func(cause error) error {
		rollbackErr := h.rollbackUpdate(ctrl, name, previous, activeDir, backupDir, updateDir, oldMoved, newMoved, stateChanged)

		if rollbackErr == nil {
			return cause
		}

		if h.logger != nil {
			h.logger.Error("update rollback failed", "plugin", name, "updateError", cause, "rollbackError", rollbackErr)
		}

		if persistErr := h.persistStoppedAfterRollbackFailure(name, previous); persistErr != nil {
			rollbackErr = fmt.Errorf("%v; persist stopped state: %w", rollbackErr, persistErr)
		}

		return fmt.Errorf("%w: update failed: %v; rollback failed: %v", backend.ErrForceStopTerminal, cause, rollbackErr)
	}

	if err := ctrl.StopService(); err != nil {
		return fail(err)
	}

	if apiErr := h.installDeps(ctx, m); apiErr != nil {
		return fail(apiErr)
	}

	if err := os.MkdirAll(h.cfg.StagingDir, 0o700); err != nil {
		return fail(httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to create update staging directory"))
	}

	var err error
	updateDir, err = os.MkdirTemp(h.cfg.StagingDir, name+"-update-")
	if err != nil {
		return fail(httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to create update staging directory"))
	}

	defer os.RemoveAll(updateDir)

	if err := extractZip(zr, updateDir); err != nil {
		return fail(httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "failed to extract update archive"))
	}

	if apiErr := markCommandsExecutable(updateDir, m); apiErr != nil {
		return fail(apiErr)
	}

	if apiErr := validateCommands(updateDir, m); apiErr != nil {
		return fail(apiErr)
	}

	if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
		if err != nil {
			return fail(err)
		}

		return fail(backend.ErrLifecycleConflict)
	}

	if err := moveDir(activeDir, backupDir); err != nil {
		return fail(httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to retain previous plugin version"))
	}

	oldMoved = true

	if err := moveDir(updateDir, activeDir); err != nil {
		return fail(httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to activate update"))
	}

	newMoved = true

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
		record.RemovalPending = false

		st.AppendAudit("update", name, "plugin version activated")

		return nil
	}); err != nil {
		return fail(httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record update"))
	}

	stateChanged = true

	desired := &registry.Plugin{
		Name: name, Dir: activeDir, Manifest: m, Source: previous.Source,
		Approval: state.ApprovalApproved, Enabled: true,
	}

	if err := ctrl.StartPlugin(desired); err != nil {
		return fail(err)
	}

	if err := h.removePluginFiles(name, backupDir); err != nil && h.logger != nil {
		h.logger.Warn("failed to remove previous plugin backup", "plugin", name, "path", backupDir, "error", err)
	}

	return nil
}

func (h *Handler) rollbackUpdate(
	ctrl backend.LifecycleControl,
	name string,
	previous *state.Plugin,
	activeDir string,
	backupDir string,
	failedDir string,
	oldMoved bool,
	newMoved bool,
	stateChanged bool,
) error {
	if newMoved {
		if err := moveDir(activeDir, failedDir); err != nil {
			return err
		}
	}

	if oldMoved {
		if err := moveDir(backupDir, activeDir); err != nil {
			return err
		}
	}

	if stateChanged {
		if err := h.store.Mutate(func(st *state.State) error {
			st.Plugins[name] = previous

			st.AppendAudit("rollback", name, "update readiness failed")

			return nil
		}); err != nil {
			return err
		}
	}

	previousManifest, err := manifest.Validate(previous.Manifest)
	if err != nil {
		return err
	}

	return ctrl.StartPlugin(&registry.Plugin{
		Name: name, Dir: activeDir, Manifest: previousManifest, Source: previous.Source,
		Approval: previous.Approval, Enabled: previous.Enabled,
	})
}

func (h *Handler) persistStoppedAfterRollbackFailure(name string, previous *state.Plugin) error {
	return h.store.Mutate(func(st *state.State) error {
		restored := *previous
		restored.Manifest = append(json.RawMessage(nil), previous.Manifest...)
		restored.Enabled = false
		st.Plugins[name] = &restored

		st.AppendAudit("rollback-failed", name, "plugin disabled after update rollback failure")

		return nil
	})
}
