package ring

import (
	"errors"
	"fmt"
)

// ErrUnsupportedFilesystem reports filesystems that cannot safely store ring rows.
var ErrUnsupportedFilesystem = errors.New("ring: unsupported filesystem")

func checkFilesystemType(fsType int64) error {
	switch fsType {
	case 0x4d44, 0x2011bab0, 0x5346544e, 0x7366746e, 0x65735546:
		return fmt.Errorf("%w: type %#x", ErrUnsupportedFilesystem, fsType)
	default:
		return nil
	}
}
