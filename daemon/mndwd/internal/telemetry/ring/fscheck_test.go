package ring

import (
	"errors"
	"testing"
)

func TestCheckFilesystemTypeBlacklist(t *testing.T) {
	for _, fsType := range []int64{0x4d44, 0x2011bab0, 0x5346544e, 0x7366746e, 0x65735546} {
		if err := checkFilesystemType(fsType); !errors.Is(err, ErrUnsupportedFilesystem) {
			t.Errorf("checkFilesystemType(%#x) = %v, want ErrUnsupportedFilesystem", fsType, err)
		}
	}

	for _, fsType := range []int64{0xEF53, 0x24051905} {
		if err := checkFilesystemType(fsType); err != nil {
			t.Errorf("checkFilesystemType(%#x) = %v, want nil", fsType, err)
		}
	}
}
