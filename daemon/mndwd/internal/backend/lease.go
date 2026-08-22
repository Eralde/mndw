package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type ServiceLease struct {
	BootID         string `json:"bootId"`
	PID            int    `json:"pid"`
	PGID           int    `json:"pgid"`
	StartTimeTicks uint64 `json:"startTimeTicks"`
	ExecutablePath string `json:"executablePath"`
	ExecutableDev  uint64 `json:"executableDev"`
	ExecutableIno  uint64 `json:"executableIno"`
}

func WriteServiceLease(path string, lease ServiceLease) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create lease directory: %w", err)
	}

	temporary, err := os.CreateTemp(filepath.Dir(path), ".service-lease-")
	if err != nil {
		return fmt.Errorf("create lease temp file: %w", err)
	}

	temporaryPath := temporary.Name()

	defer os.Remove(temporaryPath)

	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()

		return fmt.Errorf("restrict lease temp file: %w", err)
	}

	if err := json.NewEncoder(temporary).Encode(lease); err != nil {
		_ = temporary.Close()

		return fmt.Errorf("encode lease: %w", err)
	}

	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()

		return fmt.Errorf("sync lease: %w", err)
	}

	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close lease: %w", err)
	}

	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("install lease: %w", err)
	}

	return nil
}

func ReadServiceLease(path string) (ServiceLease, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ServiceLease{}, err
	}

	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return ServiceLease{}, fmt.Errorf("lease is not a private regular file")
	}

	file, err := os.Open(path)
	if err != nil {
		return ServiceLease{}, err
	}

	defer file.Close()

	var lease ServiceLease

	if err := json.NewDecoder(file).Decode(&lease); err != nil {
		return ServiceLease{}, fmt.Errorf("decode lease: %w", err)
	}

	return lease, nil
}
