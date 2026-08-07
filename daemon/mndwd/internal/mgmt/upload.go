package mgmt

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
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
		httpx.WriteError(w, h.logger,
			httpx.NewError(http.StatusBadRequest, httpx.CodeManifestInvalid, "manifest failed validation").WithDetail(err.Error()))

		return
	}

	name := *m.Name
	if apiErr := h.ensureNameFree(name); apiErr != nil {
		httpx.WriteError(w, h.logger, apiErr)

		return
	}

	stagingPath := filepath.Join(h.cfg.StagingDir, name)
	if err := extractZip(zr, stagingPath); err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidZip, "failed to extract archive: "+err.Error()))

		return
	}

	if manifest.HasBackend(m) {
		h.stagePending(w, m, manifestBytes)

		return
	}

	h.installDirect(w, m, manifestBytes, stagingPath)
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
// a builtin. For 2a a re-upload requires an explicit deny/delete first — predictable
// and collision-safe.
func (h *Handler) ensureNameFree(name string) *httpx.APIError {
	if _, exists := h.store.Get(name); exists {
		return httpx.NewError(http.StatusConflict, httpx.CodeConflict, "a plugin named "+name+" already exists; deny or delete it first")
	}
	if h.isBuiltin(name) {
		return httpx.NewError(http.StatusConflict, httpx.CodeConflict, "a builtin plugin named "+name+" exists")
	}

	return nil
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
		st.Plugins[name] = newRecord(m, manifestBytes, state.ApprovalApproved, true)
		st.AppendAudit("install", name, "no backend — installed without approval")

		return nil
	})
	if err != nil {
		httpx.WriteError(w, h.logger, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "failed to record plugin state"))

		return
	}

	h.logger.Info("plugin installed", "plugin", name, "backend", false)
	httpx.WriteJSON(w, h.logger, http.StatusCreated, h.entryFrom(m, state.SourceUser, state.ApprovalApproved, true))
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
	httpx.WriteJSON(w, h.logger, http.StatusAccepted, h.entryFrom(m, state.SourceUser, state.ApprovalPending, false))
}

// newRecord builds the durable state record from a validated manifest.
func newRecord(m *manifest.Manifest, manifestBytes []byte, approval string, enabled bool) *state.Plugin {
	return &state.Plugin{
		Name:        *m.Name,
		Source:      state.SourceUser,
		Type:        deref(m.Type),
		Version:     deref(m.Version),
		Label:       deref(m.Label),
		Approval:    approval,
		Enabled:     enabled,
		Manifest:    append([]byte(nil), manifestBytes...),
		InstalledAt: time.Now().UTC(),
	}
}
