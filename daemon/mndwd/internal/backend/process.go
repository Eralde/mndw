package backend

import (
	"fmt"
	"os"
)

type ProcessIdentity struct {
	PID            int
	PGID           int
	StartTimeTicks uint64
	ExecutablePath string
	ExecutableDev  uint64
	ExecutableIno  uint64
}

type ProcessReader interface {
	BootID() (string, error)
	ProcessIdentity(pid int) (ProcessIdentity, error)
}

type systemProcessReader struct{}

func (systemProcessReader) BootID() (string, error) { return readBootID() }

func (systemProcessReader) ProcessIdentity(pid int) (ProcessIdentity, error) {
	return ReadProcessIdentity(pid)
}

func ValidateServiceLease(lease ServiceLease, reader ProcessReader) (bool, error) {
	if lease.BootID == "" || lease.PID <= 0 || lease.PGID <= 0 || lease.StartTimeTicks == 0 || lease.ExecutablePath == "" {
		return false, fmt.Errorf("lease is incomplete")
	}

	bootID, err := reader.BootID()
	if err != nil {
		return false, fmt.Errorf("read boot ID: %w", err)
	}

	if bootID != lease.BootID {
		return false, nil
	}

	identity, err := reader.ProcessIdentity(lease.PID)
	if err != nil {
		return false, nil
	}

	if identity.PID != lease.PID || identity.PGID != lease.PGID || identity.StartTimeTicks != lease.StartTimeTicks || identity.ExecutablePath != lease.ExecutablePath || identity.ExecutableDev != lease.ExecutableDev || identity.ExecutableIno != lease.ExecutableIno {
		return false, nil
	}

	return true, nil
}

func ownProcessID() int { return os.Getpid() }
