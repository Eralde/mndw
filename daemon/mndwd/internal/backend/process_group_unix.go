//go:build darwin

package backend

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureExecCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateExecProcess(process *os.Process) error {
	err := syscall.Kill(-process.Pid, syscall.SIGTERM)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}

	return err
}

func killExecProcess(process *os.Process) error {
	err := syscall.Kill(-process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}

	return err
}

func terminateExecGroup(pgid int) error {
	err := syscall.Kill(-pgid, syscall.SIGTERM)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}

	return err
}

func killExecGroup(pgid int) error {
	err := syscall.Kill(-pgid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}

	return err
}

func processGroupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	err := syscall.Kill(-pgid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}
