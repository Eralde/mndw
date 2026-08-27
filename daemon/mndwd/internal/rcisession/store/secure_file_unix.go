//go:build !windows

package store

import (
	"fmt"
	"os"
	"syscall"
)

func validateSecureFileMetadata(info os.FileInfo) error {
	if info.Mode().Perm() != 0o600 {
		return fmt.Errorf("persistent RCI secret file has unsafe type or mode")
	}

	if stat, ok := info.Sys().(*syscall.Stat_t); ok && uint32(os.Getuid()) != stat.Uid {
		return fmt.Errorf("persistent RCI secret file has unsafe owner")
	}

	return nil
}
