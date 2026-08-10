package palette

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"mndw.local/shared/fsutil"
)

const schemaVersion = 1

type document struct {
	Version int      `json:"version"`
	Palette *Palette `json:"palette"`
}

type Store struct {
	path    string
	mu      sync.Mutex
	current *Palette
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create palette dir: %w", err)
	}

	current, err := load(path)
	if err != nil {
		return nil, err
	}

	store := &Store{path: path, current: current}
	if err := store.persist(current); err != nil {
		return nil, err
	}

	return store, nil
}

func load(path string) (*Palette, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}

		return nil, fmt.Errorf("read palette: %w", err)
	}

	if len(data) == 0 {
		return nil, nil
	}

	var doc document
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil {
		return quarantine(path), nil
	}

	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return quarantine(path), nil
	}

	if doc.Version != schemaVersion {
		return quarantine(path), nil
	}
	if doc.Palette == nil {
		return nil, nil
	}
	if err := validate(*doc.Palette); err != nil {
		return quarantine(path), nil
	}

	return doc.Palette, nil
}

func quarantine(path string) *Palette {
	_ = os.Rename(path, path+".bak")

	return nil
}

func (s *Store) Get() (Palette, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.current == nil {
		return Palette{}, false
	}

	return *s.current, true
}

func (s *Store) Set(p Palette) error {
	if err := validate(p); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.persist(&p); err != nil {
		return err
	}

	s.current = &p

	return nil
}

func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.persist(nil); err != nil {
		return err
	}

	s.current = nil

	return nil
}

func (s *Store) persist(p *Palette) error {
	if err := fsutil.AtomicWriteJSON(s.path, document{Version: schemaVersion, Palette: p}); err != nil {
		return fmt.Errorf("persist palette: %w", err)
	}
	return nil
}
