// Package store is the encrypted at-rest record of the device's RCI credentials
// (controller + per-extender tokens), sealed with AES-GCM and written atomically.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"mndwd/internal/rcisession/model"
)

var ErrUnavailable = errors.New("persistent RCI store unavailable")

type UnavailableError struct {
	State model.StoreState
}

func (e *UnavailableError) Error() string {
	return "persistent RCI store unavailable: " + string(e.State)
}
func (e *UnavailableError) Unwrap() error { return ErrUnavailable }

type Config struct {
	CiphertextFile string
	KeyFile        string
}

type Store struct {
	mu       sync.RWMutex
	state    model.StoreState
	key      []byte
	file     string
	document model.Document
}

func Open(config Config) (*Store, error) {
	if config.CiphertextFile == "" || config.KeyFile == "" {
		return nil, fmt.Errorf("persistent RCI store paths are required")
	}

	if err := ensureDirectory(filepath.Dir(config.CiphertextFile)); err != nil {
		return nil, err
	}

	store := &Store{state: model.StateEmpty, file: config.CiphertextFile, document: emptyDocument()}
	key, present, err := loadOrCreateKey(config.KeyFile, config.CiphertextFile)
	if err != nil {
		return nil, err
	}

	if !present {
		store.state = model.StateDisabled

		return store, nil
	}

	store.key = append([]byte(nil), key...)

	ciphertext, err := readCiphertext(config.CiphertextFile)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}

	if err != nil {
		store.state = model.StateDecryptFailed

		return store, nil
	}

	document, err := decryptDocument(store.key, ciphertext)
	if err != nil {
		store.state = model.StateDecryptFailed

		return store, nil
	}

	store.document = normalizeDocument(document)
	store.state = model.StateOK

	return store, nil
}

func (s *Store) State() model.StoreState {
	s.mu.RLock()

	defer s.mu.RUnlock()

	return s.state
}

func (s *Store) Snapshot() (model.Document, error) {
	s.mu.RLock()

	defer s.mu.RUnlock()

	if err := s.availableLocked(); err != nil {
		return model.Document{}, err
	}

	return cloneDocument(s.document), nil
}

func (s *Store) ReplaceController(record model.TokenRecord) error {
	return s.mutate(func(document *model.Document) {
		document.Controller = cloneRecordPtr(&record)
	})
}

func (s *Store) DeleteController() error {
	return s.mutate(func(document *model.Document) {
		document.Controller = nil
		document.Extenders = make(map[string]model.TokenRecord)
	})
}

func (s *Store) UpsertExtender(identity string, record model.TokenRecord) error {
	if identity == "" {
		return fmt.Errorf("extender identity is required")
	}

	return s.mutate(func(document *model.Document) {
		if document.Extenders == nil {
			document.Extenders = make(map[string]model.TokenRecord)
		}

		document.Extenders[identity] = record
	})
}

func (s *Store) DeleteExtender(identity string) error {
	return s.mutate(func(document *model.Document) {
		delete(document.Extenders, identity)
	})
}

func (s *Store) DeleteExtenders() error {
	return s.mutate(func(document *model.Document) {
		document.Extenders = make(map[string]model.TokenRecord)
	})
}

func (s *Store) mutate(mutation func(*model.Document)) error {
	s.mu.Lock()

	defer s.mu.Unlock()

	if err := s.availableLocked(); err != nil {
		return err
	}

	mutation(&s.document)

	return s.persistLocked()
}

func (s *Store) availableLocked() error {
	if s.state != model.StateOK && s.state != model.StateEmpty {
		return &UnavailableError{State: s.state}
	}

	return nil
}

func (s *Store) persistLocked() error {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}

	plaintext, err := json.Marshal(normalizeDocument(s.document))
	if err != nil {
		return fmt.Errorf("encode persistent RCI store: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())

	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return fmt.Errorf("create persistent RCI nonce: %w", err)
	}

	ciphertext := append(nonce, gcm.Seal(nil, nonce, plaintext, nil)...)

	if err := writeAtomic(s.file, ciphertext); err != nil {
		return err
	}

	s.state = model.StateOK

	return nil
}

func loadOrCreateKey(path, ciphertextPath string) ([]byte, bool, error) {
	if err := ensureDirectory(filepath.Dir(path)); err != nil {
		return nil, false, fmt.Errorf("prepare persistent RCI key directory: %w", err)
	}

	_, keyErr := os.Lstat(path)

	if errors.Is(keyErr, os.ErrNotExist) {
		if _, cipherErr := os.Lstat(ciphertextPath); cipherErr == nil {
			return nil, false, nil
		} else if !errors.Is(cipherErr, os.ErrNotExist) {
			return nil, false, fmt.Errorf("inspect persistent RCI ciphertext: %w", cipherErr)
		}

		key := make([]byte, 32)

		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, false, fmt.Errorf("create persistent RCI key: %w", err)
		}

		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, false, fmt.Errorf("create persistent RCI key: %w", err)
		}

		if _, err := file.Write(key); err != nil {
			_ = file.Close()

			return nil, false, fmt.Errorf("write persistent RCI key: %w", err)
		}

		if err := file.Sync(); err != nil {
			_ = file.Close()

			return nil, false, fmt.Errorf("sync persistent RCI key: %w", err)
		}

		if err := file.Close(); err != nil {
			return nil, false, fmt.Errorf("close persistent RCI key: %w", err)
		}

		return key, true, nil
	}

	if keyErr != nil {
		return nil, false, fmt.Errorf("inspect persistent RCI key: %w", keyErr)
	}

	key, err := readSecureFile(path, 32)
	if err != nil {
		return nil, false, err
	}

	return key, true, nil
}

func readCiphertext(path string) ([]byte, error) {
	return readSecureFile(path, 0)
}

func readSecureFile(path string, expectedSize int) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}

	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("persistent RCI secret file has unsafe type or mode")
	}

	if stat, ok := info.Sys().(*syscall.Stat_t); ok && uint32(os.Getuid()) != stat.Uid {
		return nil, fmt.Errorf("persistent RCI secret file has unsafe owner")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read persistent RCI secret file: %w", err)
	}

	if expectedSize > 0 && len(data) != expectedSize {
		return nil, fmt.Errorf("persistent RCI key has invalid length")
	}

	return data, nil
}

func decryptDocument(key, ciphertext []byte) (model.Document, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return model.Document{}, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil || len(ciphertext) < gcm.NonceSize() {
		return model.Document{}, fmt.Errorf("persistent RCI ciphertext is invalid")
	}

	nonce := ciphertext[:gcm.NonceSize()]
	plaintext, err := gcm.Open(nil, nonce, ciphertext[gcm.NonceSize():], nil)
	if err != nil {
		return model.Document{}, fmt.Errorf("persistent RCI ciphertext authentication failed")
	}

	var document model.Document

	if err := json.Unmarshal(plaintext, &document); err != nil {
		return model.Document{}, fmt.Errorf("persistent RCI document is invalid")
	}

	return document, nil
}

func writeAtomic(path string, data []byte) error {
	directory := filepath.Dir(path)

	if err := ensureDirectory(directory); err != nil {
		return err
	}

	temporary, err := os.CreateTemp(directory, ".rci-session-*.tmp")
	if err != nil {
		return fmt.Errorf("create persistent RCI temporary file: %w", err)
	}

	temporaryPath := temporary.Name()

	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()

	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("secure persistent RCI temporary file: %w", err)
	}

	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("write persistent RCI ciphertext: %w", err)
	}

	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync persistent RCI ciphertext: %w", err)
	}

	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close persistent RCI ciphertext: %w", err)
	}

	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace persistent RCI ciphertext: %w", err)
	}

	return nil
}

func ensureDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create persistent RCI directory: %w", err)
	}

	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("secure persistent RCI directory: %w", err)
	}

	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect persistent RCI directory: %w", err)
	}

	if !info.IsDir() {
		return fmt.Errorf("persistent RCI path is not a directory")
	}

	return nil
}

func emptyDocument() model.Document {
	return model.Document{Extenders: make(map[string]model.TokenRecord)}
}

func normalizeDocument(document model.Document) model.Document {
	if document.Extenders == nil {
		document.Extenders = make(map[string]model.TokenRecord)
	}

	return document
}

func cloneRecordPtr(record *model.TokenRecord) *model.TokenRecord {
	if record == nil {
		return nil
	}

	clone := *record

	if record.LastCheckedAt != nil {
		value := *record.LastCheckedAt
		clone.LastCheckedAt = &value
	}

	if record.RetryAfter != nil {
		value := *record.RetryAfter
		clone.RetryAfter = &value
	}

	return &clone
}

func cloneDocument(document model.Document) model.Document {
	clone := model.Document{Extenders: make(map[string]model.TokenRecord, len(document.Extenders))}
	clone.Controller = cloneRecordPtr(document.Controller)

	for identity, record := range document.Extenders {
		clone.Extenders[identity] = *cloneRecordPtr(&record)
	}

	return clone
}
