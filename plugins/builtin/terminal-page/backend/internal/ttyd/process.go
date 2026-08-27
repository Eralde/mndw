package ttyd

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"
)

type Process struct {
	getenv  func(string) string
	mu      sync.Mutex
	command *exec.Cmd
	done    chan error
	console string
}

func New(getenv func(string) string) *Process { return &Process{getenv: getenv} }

func (process *Process) Start(_ context.Context, console string) error {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.command != nil && process.command.Process != nil {
		select {
		case <-process.done:
			process.command = nil
			process.done = nil
			process.console = ""
		default:
		}
	}
	if process.command != nil && process.command.Process != nil {
		if process.console == console {
			return nil
		}
		if err := stopCommand(process.command, process.done, 2*time.Second); err != nil {
			return err
		}
		process.command = nil
		process.done = nil
	}
	binary := process.getenv("MNDW_TTYD_BIN")
	if binary == "" {
		binary = "/opt/bin/ttyd"
	}
	terminalCommand := "ndmc"
	if console == "entware" {
		terminalCommand = "/opt/bin/sh"
	}
	command := exec.Command(binary, "-i", "127.0.0.1", "-p", "7681", "-W", terminalCommand)
	configure(command)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	process.command = command
	process.done = done
	process.console = console
	return nil
}

func (process *Process) Stop(_ context.Context) error {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.command == nil || process.command.Process == nil {
		return nil
	}
	err := stopCommand(process.command, process.done, 2*time.Second)
	process.command = nil
	process.done = nil
	process.console = ""
	return err
}

func stopCommand(command *exec.Cmd, done <-chan error, grace time.Duration) error {
	if command.Process == nil {
		return nil
	}
	_ = terminate(command.Process)
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case err := <-done:
		return stoppedProcessError(command, err)
	case <-timer.C:
		_ = kill(command.Process)
		return stoppedProcessError(command, <-done)
	}
}

func stoppedProcessError(command *exec.Cmd, err error) error {
	if err != nil && command.ProcessState != nil {
		return nil
	}
	return err
}
