//go:build !darwin && !linux

package backend

import (
	"os"
	"os/exec"
)

func configureExecCommand(_ *exec.Cmd) {}

func terminateExecProcess(process *os.Process) error { return process.Signal(os.Interrupt) }

func killExecProcess(process *os.Process) error { return process.Kill() }

func terminateExecGroup(_ int) error { return nil }

func killExecGroup(_ int) error { return nil }

func processGroupAlive(_ int) bool { return false }
