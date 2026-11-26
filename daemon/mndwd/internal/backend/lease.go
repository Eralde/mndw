package backend

import (
	"encoding/json"
	"fmt"
	"io"
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

	data, err := json.Marshal(lease)
	if err != nil {
		return fmt.Errorf("encode lease: %w", err)
	}

	data = append(data, '\n')

	if err := writeServiceLeaseAtomic(path, data); err != nil {
		return fmt.Errorf("persist lease: %w", err)
	}

	return nil
}

// writeServiceLeaseAtomic writes a temporary file and renames it into place without syncing the file or directory,
// unlike fsutil.WriteFileAtomic. A lease is valid only within the boot that wrote it and is read through the page
// cache, so syncing would add flash writes and time under Supervisor.mu during readiness refresh.
func writeServiceLeaseAtomic(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".service-lease-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}

	temporaryPath := temporary.Name()

	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()

	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("chmod temporary file: %w", err)
	}

	if written, err := temporary.Write(data); err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	} else if written != len(data) {
		return fmt.Errorf("write temporary file: %w", io.ErrShortWrite)
	}

	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}

	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("rename temporary file: %w", err)
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
