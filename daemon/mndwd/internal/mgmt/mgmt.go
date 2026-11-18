// Package mgmt implements the /api/mgmt/* management API:
// upload, approve/deny, enable/disable, delete, the merged list/pending views,
// and the /api/mgmt/opkg/* package-manager endpoints.
//
// The whole surface is session-gated by the authz middleware wired in cmd/mndwd.
// approval explicitly installs declared packages; the backend runtime owns service
// processes and request-scoped command execution.
package mgmt

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/backend"
	"mndwd/internal/httpx"
	"mndwd/internal/initd"
	"mndwd/internal/manifest"
	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/selfupdate"
	"mndwd/internal/state"
)

// opkgTimeout bounds an opkg operation (install can pull over a slow link). Operations
// run on a background-derived context so a client disconnect never aborts a partial
// package install.
const opkgTimeout = 3 * time.Minute
const serviceStatusTimeout = 3 * time.Second
const serviceActionTimeout = 30 * time.Second
const uploadBodyTimeout = 120 * time.Second

// BuiltinSource supplies validated builtin plugins and owns builtin discovery
// warnings/errors. Satisfied by *registry.Registry.
type BuiltinSource interface {
	ListBuiltins() ([]*registry.Plugin, error)
}

// RuntimeResolver resolves an installed plugin snapshot for lifecycle operations.
type RuntimeResolver interface {
	Resolve(string) (*registry.Plugin, bool)
}

// ManagementEventPublisher publishes the event topics produced by management
// operations. Implementations own serialization and bus delivery.
type ManagementEventPublisher interface {
	PublishPluginInstalled(contractEvents.PluginInstalledPayload) error
	PublishPluginApproved(contractEvents.PluginApprovedPayload) error
	PublishPluginRemoved(contractEvents.PluginRemovedPayload) error
	PublishTelemetryGatheringChanged(contractEvents.TelemetryGatheringChangedPayload) error
}

// PluginRuntime exposes the runtime operations used by management handlers.
type PluginRuntime interface {
	ExecuteLifecycle(string, backend.Operation, backend.Intent, func(context.Context, backend.LifecycleControl) error) error
	BlocksTraffic(string) bool
	Status(string) backend.RuntimeStatus
	Limits() backend.RuntimeLimitsSnapshot
}

// SelfUpdateService exposes the update operations used by management handlers.
type SelfUpdateService interface {
	Status() (selfupdate.Status, error)
	Check(context.Context) (selfupdate.CheckResult, error)
	BeginUpdate(context.Context) (selfupdate.Accepted, error)
	BeginRevert(context.Context) (selfupdate.Accepted, error)
}

// Config carries the dependencies and settings used by the management API.
type Config struct {
	Store          StateStore
	OpkgManager    opkg.Manager
	ServiceManager initd.Manager
	Builtins       BuiltinSource
	Logger         *slog.Logger
	// StagingDir holds uploaded-but-unapproved plugins.
	StagingDir string
	// UserPluginsDir holds approved user plugins, served statically.
	UserPluginsDir string
	// BuiltinPluginsDir holds plugins shipped with the daemon (always approved).
	BuiltinPluginsDir string
	// MaxUploadBytes caps the request body of an upload (design: 10 MB).
	MaxUploadBytes int64
	// Runtime controls manifest exec/service lifecycle.
	Runtime PluginRuntime
	// RuntimeResolver resolves lifecycle targets; nil retains the store-backed fallback.
	RuntimeResolver RuntimeResolver
	// PersistentRCIPermissionController owns grant-triggered socket reconciliation.
	PersistentRCIPermissionController PersistentRCIPermissionController
	ServiceActionRoot                 context.Context
	ServiceActionTimeout              time.Duration
	SelfUpdate                        SelfUpdateService
	TelemetryController               TelemetryController
	EventPublisher                    ManagementEventPublisher
}

// Handler serves the management API over a shared state store.
type Handler struct {
	plugins    *pluginsAPI
	telemetry  *telemetryAPI
	opkg       *opkgAPI
	selfUpdate *selfUpdateAPI
	service    *serviceAPI
}

type pluginsAPI struct {
	stagingDir           string
	userPluginsDir       string
	builtinPluginsDir    string
	maxUploadBytes       int64
	store                StateStore
	opkg                 opkg.Manager
	builtins             BuiltinSource
	runtime              PluginRuntime
	runtimeResolver      RuntimeResolver
	permissionController PersistentRCIPermissionController
	logger               *slog.Logger
	events               managementPublisher
	removeAll            func(string) error
	newTimer             func(time.Duration) <-chan time.Time
	removalWatchdog      time.Duration
}

type telemetryAPI struct {
	store      StateStore
	logger     *slog.Logger
	controller TelemetryController
	events     managementPublisher
	actionRoot context.Context
	mu         sync.Mutex
}

type opkgAPI struct {
	manager    opkg.Manager
	logger     *slog.Logger
	actionRoot context.Context
}

type selfUpdateAPI struct {
	service    SelfUpdateService
	logger     *slog.Logger
	actionRoot context.Context
}

type serviceAPI struct {
	manager       initd.Manager
	logger        *slog.Logger
	actionRoot    context.Context
	actionTimeout time.Duration
}

type managementPublisher struct {
	publisher ManagementEventPublisher
	logger    *slog.Logger
}

func (p managementPublisher) publish(topic string, publish func(ManagementEventPublisher) error) {
	if p.publisher == nil {
		return
	}

	if err := publish(p.publisher); err != nil {
		p.logger.Warn("internal event publish failed", "topic", topic, "error", err)
	}
}

// New constructs a management Handler.
func New(cfg Config) *Handler {
	if cfg.Runtime == nil {
		panic("mgmt: Config.Runtime is required")
	}

	if cfg.ServiceActionRoot == nil {
		cfg.ServiceActionRoot = context.Background()
	}

	if cfg.ServiceActionTimeout <= 0 {
		cfg.ServiceActionTimeout = serviceActionTimeout
	}

	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}

	logger := cfg.Logger
	publisher := managementPublisher{publisher: cfg.EventPublisher, logger: logger}

	return &Handler{
		plugins: &pluginsAPI{
			stagingDir:           cfg.StagingDir,
			userPluginsDir:       cfg.UserPluginsDir,
			builtinPluginsDir:    cfg.BuiltinPluginsDir,
			maxUploadBytes:       cfg.MaxUploadBytes,
			store:                cfg.Store,
			opkg:                 cfg.OpkgManager,
			builtins:             cfg.Builtins,
			runtime:              cfg.Runtime,
			runtimeResolver:      cfg.RuntimeResolver,
			permissionController: cfg.PersistentRCIPermissionController,
			logger:               logger,
			events:               publisher,
			removeAll:            os.RemoveAll,
			newTimer:             time.After,
			removalWatchdog:      30 * time.Second,
		},
		telemetry: &telemetryAPI{
			store:      cfg.Store,
			logger:     logger,
			controller: cfg.TelemetryController,
			events:     publisher,
			actionRoot: cfg.ServiceActionRoot,
		},
		opkg:       &opkgAPI{manager: cfg.OpkgManager, logger: logger, actionRoot: cfg.ServiceActionRoot},
		selfUpdate: &selfUpdateAPI{service: cfg.SelfUpdate, logger: logger, actionRoot: cfg.ServiceActionRoot},
		service: &serviceAPI{
			manager:       cfg.ServiceManager,
			logger:        logger,
			actionRoot:    cfg.ServiceActionRoot,
			actionTimeout: cfg.ServiceActionTimeout,
		},
	}
}

// Register wires the management routes onto mux. Method-qualified patterns give a
// 405 for the wrong verb for free (Go 1.22+ ServeMux).
func (h *Handler) Register(mux *http.ServeMux) {
	h.plugins.register(mux)
	h.telemetry.register(mux)
	h.opkg.register(mux)
	h.selfUpdate.register(mux)
	h.service.register(mux)
}

func (h *pluginsAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/mgmt/upload", h.handleUpload)
	mux.HandleFunc("GET /api/mgmt/list", h.handleList)
	mux.HandleFunc("GET /api/mgmt/pending", h.handlePending)
	mux.HandleFunc("POST /api/mgmt/approve", h.handleApprove)
	mux.HandleFunc("POST /api/mgmt/deny", h.handleDeny)
	mux.HandleFunc("POST /api/mgmt/enable", h.handleEnable)
	mux.HandleFunc("POST /api/mgmt/disable", h.handleDisable)
	mux.HandleFunc("POST /api/mgmt/delete", h.handleDelete)
	mux.HandleFunc("POST /api/mgmt/restart", h.handleRestart)
	mux.HandleFunc("POST /api/mgmt/update", h.handleUpdate)
	mux.HandleFunc("GET /api/mgmt/runtime", h.handleRuntime)
	mux.HandleFunc("POST /api/mgmt/permission", h.handlePermission)
}

// opkgContext returns a daemon-lifetime-derived context bounded by opkgTimeout,
// so a client disconnect cannot abort a partial package operation while daemon
// shutdown still cancels it.
func opkgContext(root context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(root, opkgTimeout)
}

// ListEntry is one plugin as surfaced by list/pending. It merges manifest display
// fields with runtime state and the client-facing backend descriptor.
type ListEntry struct {
	Name             string          `json:"name"`
	Type             string          `json:"type"`
	Version          string          `json:"version"`
	Label            string          `json:"label"`
	Entry            string          `json:"entry"`
	Icon             string          `json:"icon,omitempty"`
	Source           state.Source    `json:"source"`
	Approval         state.Approval  `json:"approval"`
	Enabled          bool            `json:"enabled"`
	Permissions      []string        `json:"permissions,omitempty"`
	PermissionGrants map[string]bool `json:"permissionGrants,omitempty"`
	Size             *manifest.Size  `json:"size,omitempty"`
	FixedHeight      *bool           `json:"fixedHeight,omitempty"`
	Route            string          `json:"route,omitempty"`
	I18n             *manifest.I18n  `json:"i18n,omitempty"`
	// DepsStatus is always "ready" at daemon startup. Package installation is an
	// explicit approval operation, never a background startup task.
	DepsStatus string                      `json:"depsStatus"`
	Backend    *manifest.BackendDescriptor `json:"backend"`
	Review     *manifest.ApprovalReview    `json:"review,omitempty"`
	Runtime    *backend.RuntimeStatus      `json:"runtime,omitempty"`
	Lock       *PluginLock                 `json:"lock,omitempty"`
}

func (h *pluginsAPI) handleList(w http.ResponseWriter, _ *http.Request) {
	entries, err := h.buildList()
	if err != nil {
		httpx.WriteError(w, h.logger, err)

		return
	}

	httpx.WriteJSON(w, h.logger, http.StatusOK, map[string]any{"plugins": entries})
}

func (h *pluginsAPI) handlePending(w http.ResponseWriter, _ *http.Request) {
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

// buildList merges uploaded plugins (from state) with builtin plugins (scanned from
// disk) into a single, name-sorted view. Builtin manifests always come from disk;
// state supplies their persisted enabled flag.
func (h *pluginsAPI) buildList() ([]ListEntry, *httpx.APIError) {
	snap := h.store.Snapshot()
	builtinPlugins, err := h.builtins.ListBuiltins()
	if err != nil {
		return nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "cannot read builtin plugins dir")
	}

	builtinsByName := make(map[string]*registry.Plugin, len(builtinPlugins))

	for _, plugin := range builtinPlugins {
		builtinsByName[plugin.Name] = plugin
	}

	entries := make([]ListEntry, 0, len(snap.Plugins))

	for _, p := range snap.Plugins {
		if p.Source == state.SourceBuiltin {
			plugin, exists := builtinsByName[p.Name]

			if !exists {
				continue
			}

			entries = append(entries, h.entryFrom(plugin.Manifest, state.SourceBuiltin, state.ApprovalApproved, plugin.Enabled, plugin.Dir))

			continue
		}

		m, err := manifest.Validate(p.Manifest)
		if err != nil {
			// Stored manifests were validated at upload; a failure here means the
			// state file was tampered with. Skip rather than fail the whole list.
			h.logger.Error("stored manifest failed re-validation", "plugin", p.Name, "error", err)

			continue
		}

		dir := filepath.Join(h.userPluginsDir, p.Name)

		if p.Approval == state.ApprovalPending {
			dir = filepath.Join(h.stagingDir, p.Name)
		}

		entries = append(entries, h.entryFrom(m, p.Source, p.Approval, p.Enabled, dir))
	}

	for _, plugin := range builtinPlugins {
		if _, exists := snap.Plugins[plugin.Name]; exists {
			continue
		}

		entries = append(entries, h.entryFrom(plugin.Manifest, state.SourceBuiltin, state.ApprovalApproved, true, plugin.Dir))
	}

	slices.SortFunc(entries, func(left, right ListEntry) int { return cmp.Compare(left.Name, right.Name) })

	return entries, nil
}

// entryFrom projects a validated manifest plus runtime state into a ListEntry,
// including its always-present depsStatus.
func (h *pluginsAPI) entryFrom(m *manifest.Manifest, source state.Source, approval state.Approval, enabled bool, dir string) ListEntry {
	e := ListEntry{
		Name:        m.NameValue(),
		Type:        m.TypeValue(),
		Version:     m.VersionValue(),
		Label:       m.LabelValue(),
		Entry:       m.EntryValue(),
		Icon:        m.IconValue(),
		Source:      source,
		Approval:    approval,
		Enabled:     enabled,
		Size:        m.Size,
		FixedHeight: m.FixedHeight,
		Route:       m.RouteValue(),
		I18n:        m.I18n,
		Backend:     manifest.Descriptor(m),
		Review:      manifest.Review(m),
		Lock:        readPluginLock(dir),
	}
	e.DepsStatus = "ready"

	for _, permission := range m.Permissions {
		if e.Permissions == nil {
			e.Permissions = make([]string, 0, len(m.Permissions))
		}

		e.Permissions = append(e.Permissions, permission)

		if !manifest.IsPersistentRCIPermission(permission) {
			continue
		}

		if h.store.HasGrant(e.Name, permission) {
			if e.PermissionGrants == nil {
				e.PermissionGrants = make(map[string]bool)
			}

			e.PermissionGrants[permission] = true
		}
	}

	if m.HasBackendKind() {
		status := h.runtime.Status(e.Name)
		e.Runtime = &status
	}

	return e
}

// nameRequest is the shared body of approve/deny/delete.
type nameRequest struct {
	Name string `json:"name"`
}

// decodeName reads and lightly validates the {name} body common to the lifecycle
// endpoints.
func decodeName(w http.ResponseWriter, r *http.Request) (string, *httpx.APIError) {
	var req nameRequest

	defer r.Body.Close()

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return "", httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "request body must be JSON with a name field")
	}

	if req.Name == "" {
		return "", httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "name is required")
	}

	return req.Name, nil
}
