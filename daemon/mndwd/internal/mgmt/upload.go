package mgmt

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
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

// handleUpload accepts a raw application/zip body (curl: --data-binary @plugin.zip).
// The plugin name comes from the validated manifest, never the upload filename. The
// flow: cap → unzip-to-memory → validate manifest → stage → (no backend) install
// directly | (backend) leave pending for approval.
func (h *Handler) handleUpload(w http.ResponseWriter, r *http.Request) {
	data, apiErr := h.readUploadBody(w, r)

	if apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "upload is not a valid zip archive"))

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

		httpx.WriteError(w, h.logger,
			httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed validation").WithDetail(err.Error()))

		return
	}

	if err := h.validateCatalogArchive(zr, m); err != nil {
		httpx.WriteError(w, h.logger,
			httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed catalog validation").WithDetail(err.Error()))

		return
	}

	name := *m.Name

	if apiErr := h.ensureNameFree(name); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	stagingPath := filepath.Join(h.cfg.StagingDir, name)
	activePath := filepath.Join(h.cfg.UserPluginsDir, name)
	previous, hadPrevious := h.store.Get(name)
	intent := backend.IntentRun
	success := backend.TerminalRun
	approval := state.ApprovalApproved
	enabled := true
	status := http.StatusCreated
	auditDetail := "no backend — installed without approval"
	auditAction := "install"

	if manifest.HasBackend(m) {
		intent = backend.IntentStop
		success = backend.TerminalStop
		approval = state.ApprovalPending
		enabled = false
		status = http.StatusAccepted
		auditDetail = "backend declared — awaiting approval"
		auditAction = "upload"
	}

	err = h.executeLifecycle(name, backend.OpInstalling, intent, success, backend.FailRestore,
		func(ctx context.Context, ctrl backend.LifecycleControl) error {
			if err := ctx.Err(); err != nil || !ctrl.IsCurrent() {
				if err != nil {
					return err
				}

				return backend.ErrLifecycleConflict
			}

			_ = h.removeAll(stagingPath)

			if err := extractZip(zr, stagingPath); err != nil {
				return httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "failed to extract archive: "+err.Error())
			}

			backupPath := filepath.Join(h.cfg.StagingDir, name+"-reinstall-backup")
			backedUp := false

			if hadPrevious && previous.RemovalPending {
				oldPath := previous.ActiveVersionDir

				if oldPath == "" {
					oldPath = activePath
				}

				if _, statErr := os.Stat(oldPath); statErr == nil {
					if err := moveDir(oldPath, backupPath); err != nil {
						return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to retain removal-pending plugin tree")
					}

					backedUp = true
				}
			}

			installed := false

			if approval == state.ApprovalApproved {
				if err := moveDir(stagingPath, activePath); err != nil {
					h.restoreUploadFiles(activePath, backupPath, backedUp)

					return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin")
				}

				installed = true
			}

			record := newRecord(m, manifestBytes, approval, enabled)
			record.RemovalPending = false

			if installed {
				record.ActiveVersion = deref(m.Version)
				record.ActiveVersionDir = activePath
			}

			if err := h.store.Mutate(func(st *state.State) error {
				st.Plugins[name] = record

				st.AppendAudit(auditAction, name, auditDetail)

				return nil
			}); err != nil {
				h.restoreUploadFiles(activePath, backupPath, backedUp)

				return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record plugin state")
			}

			if installed {
				desired := &registry.Plugin{
					Name: name, Dir: activePath, Manifest: m, Source: state.SourceUpload,
					Approval: state.ApprovalApproved, Enabled: true,
				}

				if err := ctrl.StartPlugin(desired); err != nil {
					_ = h.restoreUploadRecord(name, previous, hadPrevious)

					h.restoreUploadFiles(activePath, backupPath, backedUp)

					return err
				}
			}

			_ = h.removeAll(backupPath)

			return nil
		})
	if err != nil {
		httpx.WriteError(w, h.logger, lifecycleError(err, http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin"))

		return
	}

	h.logger.Info("plugin upload completed", "plugin", name, "backend", manifest.HasBackend(m))
	httpx.WriteJSON(w, h.logger, status, h.entryFrom(m, state.SourceUpload, approval, enabled))
}

// readUploadBody reads the request body under the configured size cap, translating
// an over-limit body into the UPLOAD_TOO_LARGE envelope.
func (h *Handler) readUploadBody(w http.ResponseWriter, r *http.Request) ([]byte, *httpx.APIError) {
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError

		if errors.As(err, &tooLarge) {
			return nil, httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeUploadTooLarge, "upload exceeds size limit")
		}

		return nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "failed to read upload body")
	}

	if len(data) == 0 {
		return nil, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "upload body is empty")
	}

	return data, nil
}

// ensureNameFree rejects an upload whose name is already installed/pending or shadows
// a builtin. For a re-upload, explicit deny/delete is required first — predictable
// and collision-safe.
func (h *Handler) ensureNameFree(name string) *httpx.APIError {
	if record, exists := h.store.Get(name); exists && !record.RemovalPending {
		return httpx.NewError(http.StatusConflict, httpx.CodeConflict, "a plugin named "+name+" already exists; deny or delete it first")
	}

	if h.isBuiltin(name) {
		return httpx.NewError(http.StatusConflict, httpx.CodeConflict, "a builtin plugin named "+name+" exists")
	}

	return nil
}

func (h *Handler) restoreUploadFiles(activePath, backupPath string, backedUp bool) {
	_ = h.removeAll(activePath)

	if backedUp {
		_ = moveDir(backupPath, activePath)
	}
}

func (h *Handler) restoreUploadRecord(name string, previous *state.Plugin, hadPrevious bool) error {
	return h.store.Mutate(func(st *state.State) error {
		if hadPrevious {
			st.Plugins[name] = previous
		} else {
			delete(st.Plugins, name)
		}

		return nil
	})
}

// installDirect promotes a no-backend plugin straight to installed (approved+enabled)
// — approval exists for shell execution, not static assets.
func (h *Handler) installDirect(w http.ResponseWriter, m *manifest.Manifest, manifestBytes []byte, stagingPath string) {
	name := *m.Name

	if err := moveDir(stagingPath, filepath.Join(h.cfg.UserPluginsDir, name)); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to install plugin"))

		return
	}

	err := h.store.Mutate(func(st *state.State) error {
		record := newRecord(m, manifestBytes, state.ApprovalApproved, true)
		record.ActiveVersion = deref(m.Version)
		record.ActiveVersionDir = filepath.Join(h.cfg.UserPluginsDir, name)
		st.Plugins[name] = record

		st.AppendAudit("install", name, "no backend — installed without approval")

		return nil
	})
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record plugin state"))

		return
	}

	h.logger.Info("plugin installed", "plugin", name, "backend", false)
	httpx.WriteJSON(w, h.logger, http.StatusCreated, h.entryFrom(m, state.SourceUpload, state.ApprovalApproved, true))
}

// stagePending records a backend plugin as pending; it stays in staging until
// approved. The response surfaces the declared capabilities for the approval UI.
func (h *Handler) stagePending(w http.ResponseWriter, m *manifest.Manifest, manifestBytes []byte) {
	name := *m.Name
	err := h.store.Mutate(func(st *state.State) error {
		st.Plugins[name] = newRecord(m, manifestBytes, state.ApprovalPending, false)

		st.AppendAudit("upload", name, "backend declared — awaiting approval")

		return nil
	})
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record plugin state"))

		return
	}

	h.logger.Info("plugin uploaded, pending approval", "plugin", name, "backend", true)
	httpx.WriteJSON(w, h.logger, http.StatusAccepted, h.entryFrom(m, state.SourceUpload, state.ApprovalPending, false))
}

// newRecord builds the durable state record from a validated manifest.
func newRecord(m *manifest.Manifest, manifestBytes []byte, approval state.Approval, enabled bool) *state.Plugin {
	return &state.Plugin{
		Name:             *m.Name,
		Source:           state.SourceUpload,
		Type:             deref(m.Type),
		Version:          deref(m.Version),
		Label:            deref(m.Label),
		Approval:         approval,
		Enabled:          enabled,
		Manifest:         append([]byte(nil), manifestBytes...),
		InstalledAt:      time.Now().UTC(),
		InstalledVersion: deref(m.Version),
	}
}
