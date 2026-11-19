// Package fsutil contains durable filesystem operations shared by daemon packages.
package fsutil

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".atomic-*")
	if err != nil {
		return fmt.Errorf("write %s: create temporary file: %w", path, err)
	}

	temporaryPath := temporary.Name()

	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()

	written, err := temporary.Write(data)
	if err != nil {
		return fmt.Errorf("write %s: write temporary file: %w", path, err)
	}

	if written != len(data) {
		return fmt.Errorf("write %s: write temporary file: %w", path, io.ErrShortWrite)
	}

	if err := temporary.Chmod(perm); err != nil {
		return fmt.Errorf("write %s: chmod temporary file: %w", path, err)
	}

	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("write %s: sync temporary file: %w", path, err)
	}

	if err := temporary.Close(); err != nil {
		return fmt.Errorf("write %s: close temporary file: %w", path, err)
	}

	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("write %s: rename temporary file: %w", path, err)
	}

	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("write %s: open parent directory: %w", path, err)
	}

	if err := dir.Sync(); err != nil {
		_ = dir.Close()

		return fmt.Errorf("write %s: sync parent directory: %w", path, err)
	}

	if err := dir.Close(); err != nil {
		return fmt.Errorf("write %s: close parent directory: %w", path, err)
	}

	return nil
}

func UniqueBackupPath(path string, at time.Time) (string, error) {
	base := path + ".bak-" + at.UTC().Format("20060102T150405Z")

	for suffix := 0; ; suffix++ {
		candidate := base

		if suffix > 0 {
			candidate = fmt.Sprintf("%s-%d", base, suffix)
		}

		_, err := os.Lstat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			return candidate, nil
		}

		if err != nil {
			return "", fmt.Errorf("inspect backup path: %w", err)
		}
	}
}
