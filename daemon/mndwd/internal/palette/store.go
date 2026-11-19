package palette

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"mndwd/internal/fsutil"
)

const schemaVersion = 1

var renameBackupFile = os.Rename

type document struct {
	Version int      `json:"version"`
	Palette *Palette `json:"palette"`
}

type Store struct {
	path    string
	mu      sync.Mutex
	current *Palette
}

func Open(path string, loggers ...*slog.Logger) (*Store, error) {
	logger := slog.Default()

	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create palette dir: %w", err)
	}

	current, err := load(path, logger)
	if err != nil {
		return nil, err
	}

	store := &Store{path: path, current: current}

	if err := store.persist(current); err != nil {
		return nil, err
	}

	return store, nil
}

func load(path string, logger *slog.Logger) (*Palette, error) {
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
		quarantine(path, logger)

		return nil, nil
	}

	var trailing any

	if err := decoder.Decode(&trailing); err != io.EOF {
		quarantine(path, logger)

		return nil, nil
	}

	if doc.Version != schemaVersion {
		quarantine(path, logger)

		return nil, nil
	}

	if doc.Palette == nil {
		return nil, nil
	}

	if err := validate(*doc.Palette); err != nil {
		quarantine(path, logger)

		return nil, nil
	}

	return doc.Palette, nil
}

func quarantine(path string, logger *slog.Logger) {
	backupPath, err := fsutil.UniqueBackupPath(path, time.Now())
	if err != nil {
		logger.Warn("corrupt palette backup failed", "path", path, "error", err)

		return
	}

	if err := renameBackupFile(path, backupPath); err != nil {
		logger.Warn("corrupt palette backup failed", "path", path, "backup", backupPath, "error", err)

		return
	}

	logger.Warn("corrupt palette backed up", "path", backupPath)
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
	data, err := json.MarshalIndent(document{Version: schemaVersion, Palette: p}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal palette: %w", err)
	}

	if err := fsutil.WriteFileAtomic(s.path, data, 0o600); err != nil {
		return fmt.Errorf("persist palette: %w", err)
	}

	return nil
}
