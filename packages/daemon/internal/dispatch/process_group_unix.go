//go:build darwin || linux

package dispatch

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

const scriptWaitDelay = 250 * time.Millisecond

// configureScriptCommand isolates a backend script and its descendants in a
// process group so context cancellation terminates the complete script tree.
func configureScriptCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}

		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}

		return err
	}
	cmd.WaitDelay = scriptWaitDelay
}
