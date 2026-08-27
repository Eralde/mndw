//go:build !linux

package backend

import (
	"errors"
	"os"
)

func readBootID() (string, error) { return "", errors.New("boot ID is unavailable on this platform") }

func ReadProcessIdentity(_ int) (ProcessIdentity, error) { return ProcessIdentity{}, os.ErrNotExist }
