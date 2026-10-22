// Package state owns state.json: the single durable record of installed plugins,
// their approval/enable status, and the security audit trail. It is held in memory
// behind a mutex and persisted atomically (tmp + rename) so a crash mid-write can
// never corrupt the last good state.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// schemaVersion is the first released state format. Older pre-alpha state is
// deliberately not field-migrated: it is preserved as a backup and plugins are
// reinstalled with an explicit provenance.
const schemaVersion = 1

// Approval is a plugin backend's approval status. Plugins without a backend are installed
// directly as approved because they expose no executable server-side code.
type Approval string

const (
	ApprovalPending  Approval = "pending"
	ApprovalApproved Approval = "approved"
)

// Source of a plugin. Registry is reserved for a future signature-verified
// install path; it is intentionally not inferred from manifest contents.
type Source string

const (
	SourceBuiltin  Source = "builtin"
	SourceRegistry Source = "registry"
	SourceUpload   Source = "upload"
)

// Plugin is one plugin's durable record. Manifest holds the exact validated
// manifest bytes so descriptors can be rebuilt without re-reading the plugin dir;
// the denormalized display fields are conveniences for the list API.
type Plugin struct {
	Name             string          `json:"name"`
	Source           Source          `json:"source"`
	Type             string          `json:"type"`
	Version          string          `json:"version"`
	Label            string          `json:"label"`
	Approval         Approval        `json:"approval"`
	Enabled          bool            `json:"enabled"`
	RemovalPending   bool            `json:"removalPending,omitempty"`
	Manifest         json.RawMessage `json:"manifest"`
	InstalledAt      time.Time       `json:"installedAt"`
	InstalledVersion string          `json:"installedVersion,omitempty"`
	ActiveVersion    string          `json:"activeVersion,omitempty"`
	ActiveVersionDir string          `json:"activeVersionDir,omitempty"`
}

// AuditEntry is one durable, security-relevant state change.
type AuditEntry struct {
	Time   time.Time `json:"time"`
	Action string    `json:"action"`
	Plugin string    `json:"plugin"`
	Detail string    `json:"detail,omitempty"`
}

// State is the whole persisted document.
type State struct {
	Version          int                        `json:"version"`
	Plugins          map[string]*Plugin         `json:"plugins"`
	PermissionGrants map[string]map[string]bool `json:"permissionGrants,omitempty"`
	Settings         Settings                   `json:"settings,omitempty"`
	Audit            []AuditEntry               `json:"audit"`
}

type Settings struct {
	BackgroundTelemetry bool  `json:"backgroundTelemetry"`
	PersistentRCI       *bool `json:"persistentRci,omitempty"`
}

// Store is the concurrency-safe, atomically-persisted owner of a State.
type Store struct {
	path  string
	mu    sync.Mutex
	state *State
}

// Open loads the store at path, creating the parent directory and an empty state
// if none exists. A corrupt state.json is preserved as state.json.bak and replaced
// with fresh empty state, so a garbled file never wedges startup.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}

	st, err := load(path)
	if err != nil {
		return nil, err
	}

	store := &Store{path: path, state: st}

	// Persist immediately so a fresh install lands a valid file on disk.
	if err := store.persist(st); err != nil {
		return nil, err
	}

	return store, nil
}

func load(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return emptyState(), nil
		}

		return nil, fmt.Errorf("read state: %w", err)
	}

	if len(data) == 0 {
		return emptyState(), nil
	}

	var st State

	if err := json.Unmarshal(data, &st); err != nil {
		// Corrupt file: keep it for forensics, start clean rather than crash-loop.
		_ = os.Rename(path, path+".bak")

		return emptyState(), nil
	}

	if !validState(&st) {
		// A structurally valid but unsupported state is just as unsafe to
		// reinterpret as corrupt JSON. Preserve it before starting empty.
		_ = os.Rename(path, path+".bak")

		return emptyState(), nil
	}

	if st.Plugins == nil {
		st.Plugins = map[string]*Plugin{}
	}

	return &st, nil
}

func validState(st *State) bool {
	if st.Version != schemaVersion {
		return false
	}

	for name, plugin := range st.Plugins {
		if plugin == nil || plugin.Name != name || plugin.Manifest == nil || len(plugin.Manifest) == 0 {
			return false
		}

		if err := validatePlugin(name, plugin); err != nil {
			return false
		}
	}

	return true
}

func validApproval(a Approval) bool {
	return a == ApprovalPending || a == ApprovalApproved
}

func validSource(s Source) bool {
	return s == SourceBuiltin || s == SourceRegistry || s == SourceUpload
}

// validatePlugin enforces the durable approval invariant: known source and
// approval values, and enabled implying approved. pending+enabled is invalid.
func validatePlugin(name string, p *Plugin) error {
	if p == nil {
		return fmt.Errorf("plugin %q: nil record", name)
	}

	if !validSource(p.Source) {
		return fmt.Errorf("plugin %q: invalid source %q", name, p.Source)
	}

	if !validApproval(p.Approval) {
		return fmt.Errorf("plugin %q: invalid approval %q", name, p.Approval)
	}

	if p.Enabled && p.Approval != ApprovalApproved {
		return fmt.Errorf("plugin %q: enabled requires approved", name)
	}

	return nil
}

func emptyState() *State {
	return &State{
		Version: schemaVersion,
		Plugins: map[string]*Plugin{},
		Audit:   []AuditEntry{},
	}
}

// Snapshot returns a deep copy of the current state, safe to read and mutate
// without affecting the store.
func (s *Store) Snapshot() *State {
	s.mu.Lock()

	defer s.mu.Unlock()

	return clone(s.state)
}

// Get returns a copy of the named plugin's record and whether it exists.
func (s *Store) Get(name string) (*Plugin, bool) {
	s.mu.Lock()

	defer s.mu.Unlock()

	p, ok := s.state.Plugins[name]

	if !ok {
		return nil, false
	}

	return clonePlugin(p), true
}

// HasGrant reports the authoritative value of a plugin permission grant. Missing
// plugins, permissions, and nil maps all mean false.
func (s *Store) HasGrant(plugin, permission string) bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.state.PermissionGrants[plugin][permission]
}

// PersistentRCIEnabled reports the durable switch and whether it was explicitly set.
func (s *Store) PersistentRCIEnabled() (enabled bool, set bool) {
	s.mu.Lock()

	defer s.mu.Unlock()

	if s.state.Settings.PersistentRCI == nil {
		return false, false
	}

	return *s.state.Settings.PersistentRCI, true
}

// SetPersistentRCIEnabled persists the RCI session switch and its audit event atomically.
func (s *Store) SetPersistentRCIEnabled(enabled bool) error {
	return s.Mutate(func(st *State) error {
		value := enabled
		st.Settings.PersistentRCI = &value
		action := "persistent-rci-disable"

		if enabled {
			action = "persistent-rci-enable"
		}

		st.AppendAudit(action, "", "")

		return nil
	})
}

// SetGrant persists one explicit permission grant and its audit event atomically.
func (s *Store) SetGrant(plugin, permission string, enabled bool) error {
	return s.Mutate(func(st *State) error {
		if st.PermissionGrants == nil {
			st.PermissionGrants = make(map[string]map[string]bool)
		}

		if st.PermissionGrants[plugin] == nil {
			st.PermissionGrants[plugin] = make(map[string]bool)
		}

		st.PermissionGrants[plugin][permission] = enabled
		action := "permission-disable"

		if enabled {
			action = "permission-enable"
		}

		st.AppendAudit(action, plugin, "permission="+permission)

		return nil
	})
}

// Mutate is the single mutation primitive. It clones the current state, applies fn
// (which may append audit entries), persists the result atomically, and only then
// swaps it in as the live state. If persistence fails the live state is left
// untouched, keeping memory and disk in agreement.
func (s *Store) Mutate(fn func(*State) error) error {
	s.mu.Lock()

	defer s.mu.Unlock()

	next := clone(s.state)

	if err := fn(next); err != nil {
		return err
	}

	for name, plugin := range next.Plugins {
		if err := validatePlugin(name, plugin); err != nil {
			return err
		}
	}

	if err := s.persist(next); err != nil {
		return err
	}

	s.state = next

	return nil
}

// AppendAudit appends an audit entry stamped with the current time. Call inside a
// Mutate fn so it is persisted with the rest of the change.
func (st *State) AppendAudit(action, plugin, detail string) {
	st.Audit = append(st.Audit, AuditEntry{
		Time:   time.Now().UTC(),
		Action: action,
		Plugin: plugin,
		Detail: detail,
	})
}

// persist atomically writes st to disk (tmp file in the same dir, fsync, rename).
func (s *Store) persist(st *State) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, "state-*.json.tmp")
	if err != nil {
		return fmt.Errorf("create temp state: %w", err)
	}

	tmpPath := tmp.Name()

	committed := false

	defer func() {
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()

		return fmt.Errorf("write temp state: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()

		return fmt.Errorf("sync temp state: %w", err)
	}

	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp state: %w", err)
	}

	if err := os.Rename(tmpPath, s.path); err != nil {
		return fmt.Errorf("rename temp state: %w", err)
	}

	committed = true

	return nil
}

// clone deep-copies a State via JSON round-trip — correct for this small,
// plain-data document and immune to shared-map/slice aliasing bugs.
func clone(st *State) *State {
	data, err := json.Marshal(st)
	if err != nil {
		// State came from our own structs; marshaling cannot realistically fail.
		panic(fmt.Sprintf("state: clone marshal failed: %v", err))
	}

	var out State

	if err := json.Unmarshal(data, &out); err != nil {
		panic(fmt.Sprintf("state: clone unmarshal failed: %v", err))
	}

	if out.Plugins == nil {
		out.Plugins = map[string]*Plugin{}
	}

	if out.Audit == nil {
		out.Audit = []AuditEntry{}
	}

	return &out
}

func clonePlugin(p *Plugin) *Plugin {
	cp := *p

	if p.Manifest != nil {
		cp.Manifest = append(json.RawMessage(nil), p.Manifest...)
	}

	return &cp
}
