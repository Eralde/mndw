//go:build darwin

package backend

import (
	"os/exec"
	"syscall"
)

func configureExecCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
