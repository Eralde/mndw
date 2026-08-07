// Package mgmt implements the /api/mgmt/* management API:
// upload, approve/deny, enable/disable, delete, the merged list/pending views,
// and the /api/mgmt/opkg/* package-manager endpoints.
//
// The whole surface is session-gated by the authz middleware wired in cmd/mndwd.
// approve installs a plugin's opkg dependencies and starts its backend.daemon;
// enable/disable/delete drive the daemon lifecycle.
package mgmt

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/opkg"
	"mndwd/internal/readiness"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// opkgTimeout bounds an opkg operation (install can pull over a slow link). Operations
// run on a background-derived context so a client disconnect never aborts a partial
// package install.
const opkgTimeout = 3 * time.Minute

// DaemonLifecycle runs a plugin's backend.daemon start/stop hooks. Satisfied by
// *lifecycle.Manager; declared here so mgmt depends on the behavior, not the type.
type DaemonLifecycle interface {
	Start(name, dir, start string) error
	Stop(name, dir, stop string) error
}

// ReadinessSource reports a plugin's dependency-install state. Satisfied by
// *readiness.Tracker; declared here so mgmt depends on the behavior, not the type.
type ReadinessSource interface {
	Get(name string) (readiness.State, bool)
}

// BuiltinSource supplies validated builtin plugins and owns builtin discovery
// warnings/errors. Satisfied by *registry.Registry.
type BuiltinSource interface {
	ListBuiltinsWithError() ([]*registry.Plugin, error)
}

// Config carries the on-disk locations the handlers operate over.
type Config struct {
	// StagingDir holds uploaded-but-unapproved plugins.
	StagingDir string
	// UserPluginsDir holds approved user plugins, served statically.
	UserPluginsDir string
	// BuiltinPluginsDir holds plugins shipped with the daemon (always approved).
	BuiltinPluginsDir string
	// MaxUploadBytes caps the request body of an upload (design: 10 MB).
	MaxUploadBytes int64
}

// Handler serves the management API over a shared state store.
type Handler struct {
	cfg      Config
	store    StateStore
	opkg     opkg.Manager
	life     DaemonLifecycle
	ready    ReadinessSource
	builtins BuiltinSource
	logger   *slog.Logger
}

// New constructs a management Handler.
func New(cfg Config, store StateStore, opkgMgr opkg.Manager, life DaemonLifecycle, ready ReadinessSource, builtins BuiltinSource, logger *slog.Logger) *Handler {
	return &Handler{cfg: cfg, store: store, opkg: opkgMgr, life: life, ready: ready, builtins: builtins, logger: logger}
}

// Register wires the management routes onto mux. Method-qualified patterns give a
// 405 for the wrong verb for free (Go 1.22+ ServeMux).
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/mgmt/upload", h.handleUpload)
	mux.HandleFunc("GET /api/mgmt/list", h.handleList)
	mux.HandleFunc("GET /api/mgmt/pending", h.handlePending)
	mux.HandleFunc("POST /api/mgmt/approve", h.handleApprove)
	mux.HandleFunc("POST /api/mgmt/deny", h.handleDeny)
	mux.HandleFunc("POST /api/mgmt/enable", h.handleEnable)
	mux.HandleFunc("POST /api/mgmt/disable", h.handleDisable)
	mux.HandleFunc("POST /api/mgmt/delete", h.handleDelete)

	mux.HandleFunc("GET /api/mgmt/opkg/list-installed", h.handleOpkgListInstalled)
	mux.HandleFunc("GET /api/mgmt/opkg/list-available", h.handleOpkgListAvailable)
	mux.HandleFunc("GET /api/mgmt/opkg/list", h.handleOpkgList)
	mux.HandleFunc("POST /api/mgmt/opkg/install", h.handleOpkgInstall)
	mux.HandleFunc("POST /api/mgmt/opkg/remove", h.handleOpkgRemove)
	mux.HandleFunc("POST /api/mgmt/opkg/update", h.handleOpkgUpdate)
	mux.HandleFunc("POST /api/mgmt/opkg/upgrade", h.handleOpkgUpgrade)
}

// opkgContext returns a background-derived context bounded by opkgTimeout, so a
// client disconnect cannot abort a partial package operation.
func opkgContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), opkgTimeout)
}

// ListEntry is one plugin as surfaced by list/pending. It merges manifest display
// fields with runtime state and the client-facing backend descriptor.
type ListEntry struct {
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	Version     string         `json:"version"`
	Label       string         `json:"label"`
	Entry       string         `json:"entry"`
	Icon        string         `json:"icon,omitempty"`
	Source      string         `json:"source"`
	Approval    string         `json:"approval"`
	Enabled     bool           `json:"enabled"`
	Size        *manifest.Size `json:"size,omitempty"`
	FixedHeight *bool          `json:"fixedHeight,omitempty"`
	Route       string         `json:"route,omitempty"`
	// DepsStatus is the plugin's dependency-install state: "ready" | "installing" |
	// "failed". Always present; only builtins with backend.opkg installed in the
	// background can be non-ready.
	DepsStatus string                      `json:"depsStatus"`
	Backend    *manifest.BackendDescriptor `json:"backend"`
}

func (h *Handler) handleList(w http.ResponseWriter, _ *http.Request) {
	entries, err := h.buildList()
	if err != nil {
		httpx.WriteError(w, h.logger, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"plugins": entries})
}

func (h *Handler) handlePending(w http.ResponseWriter, _ *http.Request) {
	entries, err := h.buildList()
	if err != nil {
		httpx.WriteError(w, h.logger, err)

		return
	}

	pending := make([]ListEntry, 0)
	for _, e := range entries {
		if e.Approval == state.ApprovalPending {
			pending = append(pending, e)
		}
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"plugins": pending})
}

// buildList merges user plugins (from state) with builtin plugins (scanned from
// disk, always approved+enabled) into a single, name-sorted view.
func (h *Handler) buildList() ([]ListEntry, *httpx.APIError) {
	snap := h.store.Snapshot()

	entries := make([]ListEntry, 0, len(snap.Plugins))
	for _, p := range snap.Plugins {
		m, err := manifest.Validate(p.Manifest)
		if err != nil {
			// Stored manifests were validated at upload; a failure here means the
			// state file was tampered with. Skip rather than fail the whole list.
			h.logger.Error("stored manifest failed re-validation", "plugin", p.Name, "error", err)

			continue
		}
		entries = append(entries, h.entryFrom(m, p.Source, p.Approval, p.Enabled))
	}

	builtinPlugins, err := h.builtins.ListBuiltinsWithError()
	if err != nil {
		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot read builtin plugins dir")
	}
	for _, plugin := range builtinPlugins {
		if _, exists := snap.Plugins[plugin.Name]; exists {
			continue
		}
		entries = append(entries, h.entryFrom(plugin.Manifest, state.SourceBuiltin, state.ApprovalApproved, true))
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	return entries, nil
}

// depsStatusFor projects the readiness tracker's state (absence = ready) into the
// wire value.
func (h *Handler) depsStatusFor(name string) string {
	if s, ok := h.ready.Get(name); ok {
		return string(s)
	}

	return "ready"
}

// entryFrom projects a validated manifest plus runtime state into a ListEntry,
// including its always-present depsStatus.
func (h *Handler) entryFrom(m *manifest.Manifest, source, approval string, enabled bool) ListEntry {
	e := ListEntry{
		Name:        deref(m.Name),
		Type:        deref(m.Type),
		Version:     deref(m.Version),
		Label:       deref(m.Label),
		Entry:       deref(m.Entry),
		Icon:        deref(m.Icon),
		Source:      source,
		Approval:    approval,
		Enabled:     enabled,
		Size:        m.Size,
		FixedHeight: m.FixedHeight,
		Route:       deref(m.Route),
		Backend:     manifest.Descriptor(m),
	}
	e.DepsStatus = h.depsStatusFor(e.Name)

	return e
}

func deref(s *string) string {
	if s == nil {
		return ""
	}

	return *s
}

// nameRequest is the shared body of approve/deny/delete.
type nameRequest struct {
	Name string `json:"name"`
}

// decodeName reads and lightly validates the {name} body common to the lifecycle
// endpoints.
func decodeName(r *http.Request) (string, *httpx.APIError) {
	var req nameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return "", httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be JSON with a name field")
	}
	if req.Name == "" {
		return "", httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "name is required")
	}

	return req.Name, nil
}
