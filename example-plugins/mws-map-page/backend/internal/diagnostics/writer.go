// Package diagnostics writes the language-neutral per-plugin diagnostics contract.
package diagnostics

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Writer atomically publishes one plugin diagnostics document.
type Writer struct {
	Path  string
	Clock func() time.Time
}

type envelope struct {
	SchemaVersion int            `json:"schemaVersion"`
	GeneratedAt   time.Time      `json:"generatedAt"`
	Data          map[string]any `json:"data"`
}

// Write publishes data without creating its parent directory or logging its contents.
func (w Writer) Write(data map[string]any) error {
	if w.Path == "" {
		return fmt.Errorf("diagnostics path is empty")
	}
	clock := w.Clock
	if clock == nil {
		clock = time.Now
	}
	temporary, err := os.CreateTemp(filepath.Dir(w.Path), ".diagnostics-*")
	if err != nil {
		return fmt.Errorf("create diagnostics temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()

	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("restrict diagnostics temporary file: %w", err)
	}
	document := envelope{SchemaVersion: 1, GeneratedAt: clock().UTC(), Data: data}
	if err := json.NewEncoder(temporary).Encode(document); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("encode diagnostics: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync diagnostics temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close diagnostics temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, w.Path); err != nil {
		return fmt.Errorf("rename diagnostics temporary file: %w", err)
	}
	committed = true

	return nil
}
