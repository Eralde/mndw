//go:build !darwin && !linux

package dispatch

import (
	"os/exec"
	"time"
)

const scriptWaitDelay = 250 * time.Millisecond

// configureScriptCommand keeps default os/exec cancellation on platforms
// without the Unix process-group API, while still bounding inherited pipes.
func configureScriptCommand(cmd *exec.Cmd) {
	cmd.WaitDelay = scriptWaitDelay
}
