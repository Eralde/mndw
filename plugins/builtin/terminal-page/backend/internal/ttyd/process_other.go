//go:build !darwin && !linux

package ttyd

import (
	"os"
	"os/exec"
)

func configure(_ *exec.Cmd)               {}
func terminate(process *os.Process) error { return process.Signal(os.Interrupt) }
func kill(process *os.Process) error      { return process.Kill() }
