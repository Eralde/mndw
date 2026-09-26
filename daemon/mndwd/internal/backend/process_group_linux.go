//go:build linux

package backend

import (
	"os/exec"
	"syscall"
)

func configureExecCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}
