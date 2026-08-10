// Package fsutil contains filesystem helpers shared by daemon and plugin code.
package fsutil

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// AtomicWriteJSON writes value as indented JSON to path using a temporary file
// in the destination directory, an fsync, and an atomic rename. The destination
// directory must already exist.
func AtomicWriteJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}

	temp, err := os.CreateTemp(filepath.Dir(path), ".atomic-*.tmp")
	if err != nil {
		return err
	}

	tempPath := temp.Name()
	committed := false

	defer func() {
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()

		return err
	}

	if err := temp.Sync(); err != nil {
		_ = temp.Close()

		return err
	}

	if err := temp.Close(); err != nil {
		return err
	}

	if err := os.Rename(tempPath, path); err != nil {
		return err
	}

	committed = true

	return nil
}
