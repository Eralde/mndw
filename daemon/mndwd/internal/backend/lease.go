package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"mndwd/internal/fsutil"
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

	data, err := json.Marshal(lease)
	if err != nil {
		return fmt.Errorf("encode lease: %w", err)
	}

	data = append(data, '\n')

	if err := fsutil.WriteFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("persist lease: %w", err)
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
