//go:build !windows

package selfupdate

import (
	"os"
	"os/exec"
	"syscall"
)

func startDetached(script string, args []string, lockFile *os.File) error {
	commandArgs := append([]string{script}, args...)
	cmd := exec.Command("/bin/sh", commandArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.ExtraFiles = []*os.File{lockFile}

	if err := cmd.Start(); err != nil {
		return err
	}

	go func() { _ = cmd.Wait() }()

	return nil
}
