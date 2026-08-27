//go:build windows

package store

import "os"

// Windows file access is governed by ACLs rather than Unix mode and UID bits.
func validateSecureFileMetadata(_ os.FileInfo) error {
	return nil
}
