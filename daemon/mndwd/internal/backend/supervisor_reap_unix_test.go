//go:build darwin || linux

package backend

import (
	"os/exec"
	"testing"
	"time"
)

func TestReapProcessGroupEscalatesAtDeadline(t *testing.T) {
	command := exec.Command("sh", "-c", "while :; do sleep 1; done")

	configureExecCommand(command)

	if err := command.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}

	done := make(chan error, 1)
	waited := false

	go func() { done <- command.Wait() }()

	t.Cleanup(func() {
		if waited {
			return
		}

		_ = killExecGroup(command.Process.Pid)

		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	})

	// Zero timeout must not touch a still-live process group.
	reapProcessGroup(command.Process.Pid, 0)

	if !processGroupAlive(command.Process.Pid) {
		t.Fatal("zero-timeout reap killed live process group")
	}

	// The child does not exit on its own. Returning and observing Wait proves
	// the deadline branch called killExecGroup.
	reapProcessGroup(command.Process.Pid, 20*time.Millisecond)

	select {
	case <-done:
		waited = true
	case <-time.After(2 * time.Second):
		t.Fatal("child remained alive after reap deadline")
	}
}
