package ttyd

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Console identifies one independent ttyd server. Each console owns its own
// process, port and terminal command; starting one never stops another.
type Console string

const (
	ConsoleNDMC    Console = "ndmc"
	ConsoleEntware Console = "entware"
)

const (
	ndmcPort    = "7681"
	entwarePort = "7682"
)

// ParseConsole validates a console name. The empty value and the legacy
// "router" name map to ndmc for backward compatibility.
func ParseConsole(value string) (Console, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "ndmc", "router":
		return ConsoleNDMC, true
	case "entware":
		return ConsoleEntware, true
	default:
		return "", false
	}
}

func (console Console) port() string {
	if console == ConsoleEntware {
		return entwarePort
	}

	return ndmcPort
}

// Address is the loopback address ttyd listens on for this console.
func (console Console) Address() string { return "127.0.0.1:" + console.port() }

func (console Console) terminalCommand() string {
	if console == ConsoleEntware {
		return "/opt/bin/sh"
	}

	return "ndmc"
}

type Process struct {
	getenv  func(string) string
	console Console
	mu      sync.Mutex
	command *exec.Cmd
	done    chan error
}

func New(getenv func(string) string, console Console) *Process {
	return &Process{getenv: getenv, console: console}
}

func (process *Process) Start(_ context.Context) error {
	process.mu.Lock()

	defer process.mu.Unlock()

	process.clearExitedLocked()

	if process.command != nil && process.command.Process != nil {
		return nil
	}

	binary := process.getenv("MNDW_TTYD_BIN")

	if binary == "" {
		binary = "/opt/bin/ttyd"
	}

	command := exec.Command(
		binary,
		"-i", "127.0.0.1",
		"-p", process.console.port(),
		"-W",
		process.console.terminalCommand(),
	)

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

	return nil
}

// Running reports whether the owned process is still alive. An exited process
// is forgotten so a later Start can launch a fresh one.
func (process *Process) Running() bool {
	process.mu.Lock()

	defer process.mu.Unlock()

	process.clearExitedLocked()

	return process.command != nil && process.command.Process != nil
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

	return err
}

func (process *Process) clearExitedLocked() {
	if process.command == nil || process.command.Process == nil || process.done == nil {
		return
	}

	select {
	case <-process.done:
		process.command = nil
		process.done = nil
	default:
	}
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
