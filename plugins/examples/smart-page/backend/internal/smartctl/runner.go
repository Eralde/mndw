package smartctl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"sync"
	"time"

	"smart-page/internal/model"
)

const defaultWaitDelay = 250 * time.Millisecond

type Runner struct {
	binary      string
	timeout     time.Duration
	waitDelay   time.Duration
	prefixArgs  []string
	env         []string
	afterOutput func()
}

type boundedCapture struct {
	limit      int
	data       []byte
	overflow   bool
	overflowFn func()
	writeFn    func()
	wrote      bool
	mu         sync.Mutex
}

type drainResult struct {
	err error
}

func ResolveBinary() (string, error) {
	return resolveBinary(os.Stat)
}

func resolveBinary(stat func(string) (os.FileInfo, error)) (string, error) {
	for _, path := range []string{"/opt/sbin/smartctl", "/opt/bin/smartctl"} {
		if _, err := stat(path); err == nil {
			return path, nil
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("stat smartctl binary %s: %w", path, err)
		}
	}

	return "", fmt.Errorf("smartctl binary not found in fixed Entware paths")
}

func NewRunner(binary string) *Runner {
	return &Runner{
		binary:    binary,
		timeout:   model.SmartctlTimeout,
		waitDelay: defaultWaitDelay,
	}
}

func (runner *Runner) Run(ctx context.Context, command model.Command) model.CommandResult {
	result := model.CommandResult{ExitCode: -1}

	if command.Mode != "manual" && command.Mode != "scan" && command.Mode != "scan-scsi" && command.Mode != "version" {
		result.Failure = model.FailureInvalidCommand

		return result
	}

	if runner.binary == "" {
		result.Failure = model.FailureBinaryUnavailable

		return result
	}

	timeout := runner.timeout

	if timeout <= 0 {
		timeout = model.SmartctlTimeout
	}

	waitDelay := runner.waitDelay

	if waitDelay <= 0 {
		waitDelay = defaultWaitDelay
	}

	args := make([]string, 0, len(runner.prefixArgs)+5)
	args = append(args, runner.prefixArgs...)
	args = append(args, runner.commandArgs(command)...)
	childCtx, cancel := context.WithTimeout(ctx, timeout)

	defer cancel()

	cmd := exec.CommandContext(childCtx, runner.binary, args...)
	cmd.WaitDelay = waitDelay

	if runner.env != nil {
		cmd.Env = runner.env
	}

	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		result.Failure = model.FailureStartFailed

		return result
	}

	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		_ = stdoutReader.Close()
		_ = stdoutWriter.Close()
		result.Failure = model.FailureStartFailed

		return result
	}

	var cancelOnce sync.Once
	var cancelErr error
	cmd.Cancel = func() error {
		cancelOnce.Do(func() {
			if cmd.Process == nil {
				return
			}

			cancelErr = cmd.Process.Kill()

			if errors.Is(cancelErr, os.ErrProcessDone) {
				cancelErr = nil
			}
		})

		return cancelErr
	}

	stdout := &boundedCapture{limit: model.MaxSmartctlStdoutBytes}
	stderr := &boundedCapture{limit: model.MaxSmartctlStderrBytes}
	var overflowOnce sync.Once
	var outputOnce sync.Once
	killOnOverflow := func() {
		overflowOnce.Do(func() {
			_ = cmd.Cancel()
		})
	}
	signalOutput := func() {
		outputOnce.Do(func() {
			if runner.afterOutput != nil {
				runner.afterOutput()
			}
		})
	}
	stdout.overflowFn = killOnOverflow
	stderr.overflowFn = killOnOverflow
	stdout.writeFn = signalOutput
	stderr.writeFn = signalOutput
	cmd.Stdout = stdoutWriter
	cmd.Stderr = stderrWriter

	if err := cmd.Start(); err != nil {
		_ = stdoutReader.Close()
		_ = stdoutWriter.Close()
		_ = stderrReader.Close()
		_ = stderrWriter.Close()
		result.Failure = commandFailure(ctx, childCtx, err)

		return result
	}

	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()

	drainResults := make(chan drainResult, 2)

	go drainOutput(stdoutReader, stdout, drainResults)

	go drainOutput(stderrReader, stderr, drainResults)

	waitErr := cmd.Wait()

	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}

	drainsComplete := true
	drainTimer := time.NewTimer(waitDelay)
	completedDrains := 0

	for completedDrains < 2 {
		select {
		case drained := <-drainResults:
			completedDrains++

			if drained.err != nil {
				drainsComplete = false
			}
		case <-drainTimer.C:
			drainsComplete = false
			_ = stdoutReader.Close()
			_ = stderrReader.Close()

			for completedDrains < 2 {
				<-drainResults

				completedDrains++
			}
		}
	}

	drainTimer.Stop()

	if stdout.hasOverflow() || stderr.hasOverflow() {
		result.Failure = model.FailureOutputLimit

		return result
	}

	if !drainsComplete || errors.Is(waitErr, exec.ErrWaitDelay) {
		result.Failure = model.FailureWaitFailed

		return result
	}

	if failure := contextFailure(ctx, childCtx); failure != "" {
		result.Failure = failure

		return result
	}

	if waitErr != nil {
		var exitErr *exec.ExitError

		if !errors.As(waitErr, &exitErr) || result.ExitCode < 0 {
			result.Failure = model.FailureWaitFailed

			return result
		}
	}

	result.Stdout = stdout.bytes()
	result.Stderr = stderr.bytes()

	return result
}

func drainOutput(reader *os.File, capture *boundedCapture, results chan<- drainResult) {
	_, err := io.Copy(capture, reader)
	_ = reader.Close()
	results <- drainResult{err: err}
}

func (runner *Runner) Scan(ctx context.Context) model.CommandResult {
	return runner.Run(ctx, model.Command{Mode: "scan"})
}

func (runner *Runner) ScanSCSI(ctx context.Context) model.CommandResult {
	return runner.Run(ctx, model.Command{Mode: "scan-scsi"})
}

func (runner *Runner) Version(ctx context.Context) model.CommandResult {
	return runner.Run(ctx, model.Command{Mode: "version"})
}

func (runner *Runner) commandArgs(command model.Command) []string {
	if command.Mode == "version" {
		return []string{"--version"}
	}

	if command.Mode == "scan" {
		return []string{"--scan", "-j"}
	}

	if command.Mode == "scan-scsi" {
		return []string{"--scan", "-d", "scsi", "-j"}
	}

	return []string{"-a", "--json=v", "-d", command.Target.Type, command.Target.Path}
}

func commandFailure(parent context.Context, child context.Context, err error) string {
	if failure := contextFailure(parent, child); failure != "" {
		return failure
	}

	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		return model.FailureBinaryUnavailable
	}

	if errors.Is(err, fs.ErrPermission) {
		return model.FailurePermissionDenied
	}

	return model.FailureStartFailed
}

func contextFailure(parent context.Context, child context.Context) string {
	if errors.Is(parent.Err(), context.DeadlineExceeded) || errors.Is(child.Err(), context.DeadlineExceeded) {
		return model.FailureTimeout
	}

	if parent.Err() != nil || child.Err() != nil {
		return model.FailureCanceled
	}

	return ""
}

func (capture *boundedCapture) Write(value []byte) (int, error) {
	capture.mu.Lock()

	writeFn := capture.writeFn

	if len(value) > 0 && !capture.wrote {
		capture.wrote = true
	} else {
		writeFn = nil
	}

	if capture.overflow {
		capture.mu.Unlock()

		if writeFn != nil {
			writeFn()
		}

		return len(value), nil
	}

	remaining := capture.limit - len(capture.data)

	if len(value) > remaining {
		if remaining > 0 {
			capture.data = append(capture.data, value[:remaining]...)
		}

		capture.overflow = true
		overflowFn := capture.overflowFn

		capture.mu.Unlock()

		if writeFn != nil {
			writeFn()
		}

		if overflowFn != nil {
			overflowFn()
		}

		return len(value), nil
	}

	capture.data = append(capture.data, value...)

	capture.mu.Unlock()

	if writeFn != nil {
		writeFn()
	}

	return len(value), nil
}

func (capture *boundedCapture) bytes() []byte {
	capture.mu.Lock()

	defer capture.mu.Unlock()

	return append([]byte(nil), capture.data...)
}

func (capture *boundedCapture) hasOverflow() bool {
	capture.mu.Lock()

	defer capture.mu.Unlock()

	return capture.overflow
}
