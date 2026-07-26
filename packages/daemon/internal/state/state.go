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

// schemaVersion is the on-disk state.json format version. Bump when the shape
// changes in a non-backward-compatible way.
const schemaVersion = 1

// Approval status of a plugin's backend. Plugins without a backend are installed
// directly as approved because they do not expose executable server-side code.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
)

// Source of a plugin: shipped with the daemon, or user-uploaded.
const (
	SourceBuiltin = "builtin"
	SourceUser    = "user"
)

// Plugin is one plugin's durable record. Manifest holds the exact validated
// manifest bytes so descriptors can be rebuilt without re-reading the plugin dir;
// the denormalized display fields are conveniences for the list API.
type Plugin struct {
	Name        string          `json:"name"`
	Source      string          `json:"source"`
	Type        string          `json:"type"`
	Version     string          `json:"version"`
	Label       string          `json:"label"`
	Approval    string          `json:"approval"`
	Enabled     bool            `json:"enabled"`
	Manifest    json.RawMessage `json:"manifest"`
	InstalledAt time.Time       `json:"installedAt"`
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
	Version int                `json:"version"`
	Plugins map[string]*Plugin `json:"plugins"`
	Audit   []AuditEntry       `json:"audit"`
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

	if st.Plugins == nil {
		st.Plugins = map[string]*Plugin{}
	}
	st.Version = schemaVersion

	return &st, nil
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
