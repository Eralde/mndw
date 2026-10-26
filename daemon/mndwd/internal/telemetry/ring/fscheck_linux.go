//go:build linux

package ring

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// CheckFilesystem rejects filesystems whose durability semantics are unsuitable for ring storage.
func CheckFilesystem(dir string) error {
	var stat unix.Statfs_t

	if err := unix.Statfs(dir, &stat); err != nil {
		return fmt.Errorf("ring: stat filesystem: %w", err)
	}

	return checkFilesystemType(int64(stat.Type))
}
