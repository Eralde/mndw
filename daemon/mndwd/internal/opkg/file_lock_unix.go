//go:build !windows

package opkg

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func tryLockExclusive(file *os.File) (busy bool, err error) {
	err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return true, nil
	}

	return false, err
}

func unlockFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
