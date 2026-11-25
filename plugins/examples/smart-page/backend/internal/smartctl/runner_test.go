package smartctl

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"smart-page/internal/model"
)

const testRunnerDeadline = 5 * time.Second

func TestRunnerArgsAndExitJSON(t *testing.T) {
	runner := newTestRunner(t, "args", 8, testRunnerDeadline)
	got := runner.Run(context.Background(), model.Command{
		Mode: "manual",
		Target: model.Target{
			Path: "/dev/disk with spaces",
			Type: "sat,12/34 with spaces",
		},
	})

	if got.Failure != "" {
		t.Fatalf("Run() failure = %q", got.Failure)
	}

	if got.ExitCode != 8 {
		t.Fatalf("Run() exit code = %d, want 8", got.ExitCode)
	}

	if string(got.Stdout) != `{"smartctl":{"version":[7,5]}}` {
		t.Fatalf("Run() stdout = %q", got.Stdout)
	}

	assertArgs(t, got.Stderr, []string{"-a", "--json=v", "-d", "sat,12/34 with spaces", "/dev/disk with spaces"})

	scanRunner := newTestRunner(t, "args", 0, testRunnerDeadline)
	scan := scanRunner.Scan(context.Background())

	if scan.Failure != "" {
		t.Fatalf("Scan() failure = %q", scan.Failure)
	}

	if scan.ExitCode != 0 {
		t.Fatalf("Scan() exit code = %d, want 0", scan.ExitCode)
	}

	assertArgs(t, scan.Stderr, []string{"--scan", "-j"})

	scsiRunner := newTestRunner(t, "args", 0, testRunnerDeadline)
	scsiScan := scsiRunner.ScanSCSI(context.Background())

	if scsiScan.Failure != "" || scsiScan.ExitCode != 0 {
		t.Fatalf("ScanSCSI() = %+v, want exit 0", scsiScan)
	}

	assertArgs(t, scsiScan.Stderr, []string{"--scan", "-d", "scsi", "-j"})

	unknown := runner.Run(context.Background(), model.Command{Mode: "decode"})

	if unknown.Failure != model.FailureInvalidCommand {
		t.Fatalf("unknown mode failure = %q, want %q", unknown.Failure, model.FailureInvalidCommand)
	}
}

func TestRunnerLimits(t *testing.T) {
	t.Run("accepts exact limits", func(t *testing.T) {
		runner := newTestRunner(t, "write", 0, testRunnerDeadline)
		runner.env = withHelperEnv(runner.env,
			"SMARTCTL_STDOUT_BYTES=1048576",
			"SMARTCTL_STDERR_BYTES=16384",
		)

		got := runner.Scan(context.Background())

		if got.Failure != "" {
			t.Fatalf("Scan() failure = %q", got.Failure)
		}

		if len(got.Stdout) != 1<<20 || len(got.Stderr) != 16<<10 {
			t.Fatalf("captured lengths = (%d, %d), want (%d, %d)", len(got.Stdout), len(got.Stderr), 1<<20, 16<<10)
		}
	})

	t.Run("rejects stdout overflow without partial output", func(t *testing.T) {
		runner := newTestRunner(t, "write-hold", 0, testRunnerDeadline)
		runner.env = withHelperEnv(runner.env,
			"SMARTCTL_STDOUT_BYTES=1048577",
			"SMARTCTL_STDERR_BYTES=0",
		)

		got := runner.Scan(context.Background())

		assertOutputOverflow(t, got)
	})

	t.Run("rejects stderr overflow without partial output", func(t *testing.T) {
		runner := newTestRunner(t, "write-hold", 0, testRunnerDeadline)
		runner.env = withHelperEnv(runner.env,
			"SMARTCTL_STDOUT_BYTES=0",
			"SMARTCTL_STDERR_BYTES=16385",
		)

		got := runner.Scan(context.Background())

		assertOutputOverflow(t, got)
	})

	t.Run("kills simultaneous writers that keep pipes open", func(t *testing.T) {
		runner := newTestRunner(t, "write-hold", 0, testRunnerDeadline)
		runner.env = withHelperEnv(runner.env,
			"SMARTCTL_STDOUT_BYTES=1048577",
			"SMARTCTL_STDERR_BYTES=16385",
		)

		started := time.Now()
		got := runner.Scan(context.Background())

		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("overflow took %s, want under 1s", elapsed)
		}

		assertOutputOverflow(t, got)
	})
}

func TestRunnerCancellation(t *testing.T) {
	runner := newTestRunner(t, "write-hold", 0, testRunnerDeadline)
	runner.env = withHelperEnv(runner.env,
		"SMARTCTL_STDOUT_BYTES=1024",
		"SMARTCTL_STDERR_BYTES=1024",
	)
	ready := make(chan struct{})
	runner.afterOutput = func() {
		close(ready)
	}

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	result := make(chan model.CommandResult, 1)

	go func() {
		result <- runner.Scan(ctx)
	}()

	select {
	case <-ready:
	case <-time.After(testRunnerDeadline):
		t.Fatal("helper did not write output before cancellation")
	}

	startedAt := time.Now()

	cancel()

	select {
	case got := <-result:
		if got.Failure != model.FailureCanceled {
			t.Fatalf("Scan() failure = %q, want %q", got.Failure, model.FailureCanceled)
		}

		if got.Stdout != nil || got.Stderr != nil {
			t.Fatalf("cancellation retained partial output: stdout=%d bytes stderr=%d bytes", len(got.Stdout), len(got.Stderr))
		}

		if elapsed := time.Since(startedAt); elapsed > time.Second {
			t.Fatalf("cancel took %s, want under 1s", elapsed)
		}
	case <-time.After(time.Second):
		t.Fatal("Scan() did not reap helper after cancellation")
	}
}

func TestRunnerRejectsDescendantHoldingPipes(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "descendant.pid")
	runner := newTestRunner(t, "descendant", 8, testRunnerDeadline)
	runner.env = withHelperEnv(runner.env, "SMARTCTL_DESCENDANT_PID_FILE="+pidPath)

	t.Cleanup(func() {
		killHelperDescendant(t, pidPath)
	})

	started := time.Now()
	got := runner.Scan(context.Background())

	if got.Failure != model.FailureWaitFailed {
		t.Fatalf("Scan() failure = %q, want %q", got.Failure, model.FailureWaitFailed)
	}

	if got.ExitCode != 8 {
		t.Fatalf("Scan() exit code = %d, want 8", got.ExitCode)
	}

	if got.Stdout != nil || got.Stderr != nil {
		t.Fatalf("incomplete output was retained: stdout=%q stderr=%q", got.Stdout, got.Stderr)
	}

	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("incomplete pipe cleanup took %s, want under 1s", elapsed)
	}
}

func TestResolveBinaryUsesOnlyFixedPaths(t *testing.T) {
	var checked []string
	path, err := resolveBinary(func(name string) (os.FileInfo, error) {
		checked = append(checked, name)

		if name == "/opt/bin/smartctl" {
			return os.Stat(os.Args[0])
		}

		return nil, os.ErrNotExist
	})
	if err != nil {
		t.Fatalf("resolveBinary() error = %v", err)
	}

	if path != "/opt/bin/smartctl" {
		t.Fatalf("resolveBinary() = %q, want /opt/bin/smartctl", path)
	}

	if want := []string{"/opt/sbin/smartctl", "/opt/bin/smartctl"}; !equalStrings(checked, want) {
		t.Fatalf("checked paths = %#v, want %#v", checked, want)
	}
}

func TestHelperProcess(t *testing.T) {
	if os.Getenv("SMARTCTL_HELPER") != "1" {
		return
	}

	mode := os.Getenv("SMARTCTL_HELPER_MODE")

	switch mode {
	case "args":
		encodedArgs, err := json.Marshal(helperArgs())
		if err != nil {
			os.Exit(2)
		}

		if _, err := os.Stderr.Write(encodedArgs); err != nil {
			os.Exit(2)
		}

		if _, err := io.WriteString(os.Stdout, `{"smartctl":{"version":[7,5]}}`); err != nil {
			os.Exit(2)
		}
	case "write", "write-hold":
		stdoutBytes := helperInt("SMARTCTL_STDOUT_BYTES")
		stderrBytes := helperInt("SMARTCTL_STDERR_BYTES")
		writeErr := writeBoth(stdoutBytes, stderrBytes)

		if mode == "write-hold" {
			time.Sleep(24 * time.Hour)
		}

		if writeErr != nil {
			os.Exit(0)
		}
	case "descendant":
		if _, err := io.WriteString(os.Stdout, "head"); err != nil {
			os.Exit(2)
		}

		descendant := exec.Command(os.Args[0], "-test.run=^TestPipeHolderProcess$")
		descendant.Env = append(os.Environ(), "SMARTCTL_PIPE_HOLDER=1")
		descendant.Stdout = os.Stdout
		descendant.Stderr = os.Stderr

		if err := descendant.Start(); err != nil {
			os.Exit(2)
		}

		pidPath := os.Getenv("SMARTCTL_DESCENDANT_PID_FILE")

		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(descendant.Process.Pid)), 0o600); err != nil {
			_ = descendant.Process.Kill()

			os.Exit(2)
		}
	case "hold":
		time.Sleep(24 * time.Hour)
	default:
		os.Exit(2)
	}

	exitCode := helperInt("SMARTCTL_HELPER_EXIT")

	os.Exit(exitCode)
}

func TestPipeHolderProcess(t *testing.T) {
	if os.Getenv("SMARTCTL_PIPE_HOLDER") != "1" {
		return
	}

	time.Sleep(2 * time.Second)

	_, _ = io.WriteString(os.Stdout, "tail")
}

func newTestRunner(t *testing.T, mode string, exitCode int, timeout time.Duration) *Runner {
	t.Helper()

	env := append(os.Environ(),
		"SMARTCTL_HELPER=1",
		"SMARTCTL_HELPER_MODE="+mode,
		"SMARTCTL_HELPER_EXIT="+strconv.Itoa(exitCode),
	)

	return &Runner{
		binary:     os.Args[0],
		prefixArgs: []string{"-test.run=TestHelperProcess", "--"},
		env:        env,
		timeout:    timeout,
		waitDelay:  100 * time.Millisecond,
	}
}

func withHelperEnv(env []string, values ...string) []string {
	updated := append([]string(nil), env...)
	updated = append(updated, values...)

	return updated
}

func helperArgs() []string {
	for index, arg := range os.Args {
		if arg == "--" {
			return os.Args[index+1:]
		}
	}

	return nil
}

func helperInt(key string) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return 0
	}

	return value
}

func writeBoth(stdoutBytes int, stderrBytes int) error {
	start := make(chan struct{})
	errors := make(chan error, 2)

	go func() {
		<-start

		errors <- writeBytes(os.Stdout, stdoutBytes, 'o')
	}()

	go func() {
		<-start

		errors <- writeBytes(os.Stderr, stderrBytes, 'e')
	}()

	close(start)

	if err := <-errors; err != nil {
		return err
	}

	return <-errors
}

func writeBytes(writer io.Writer, size int, value byte) error {
	chunk := bytes.Repeat([]byte{value}, 32*1024)

	for size > 0 {
		writeSize := min(size, len(chunk))
		written, err := writer.Write(chunk[:writeSize])
		if err != nil {
			return err
		}

		if written != writeSize {
			return io.ErrShortWrite
		}

		size -= written
	}

	return nil
}

func assertArgs(t *testing.T, gotJSON []byte, want []string) {
	t.Helper()

	var got []string

	if err := json.Unmarshal(gotJSON, &got); err != nil {
		t.Fatalf("helper argv is invalid JSON %q: %v", gotJSON, err)
	}

	if !equalStrings(got, want) {
		t.Fatalf("argv = %#v, want %#v", got, want)
	}
}

func assertOutputOverflow(t *testing.T, got model.CommandResult) {
	t.Helper()

	if got.Failure != model.FailureOutputLimit {
		t.Fatalf("Failure = %q, want %q", got.Failure, model.FailureOutputLimit)
	}

	if got.Stdout != nil || got.Stderr != nil {
		t.Fatalf("overflow retained partial output: stdout=%d bytes stderr=%d bytes", len(got.Stdout), len(got.Stderr))
	}
}

func killHelperDescendant(t *testing.T, pidPath string) {
	t.Helper()

	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Errorf("read helper descendant PID: %v", err)

		return
	}

	pid, err := strconv.Atoi(string(pidBytes))
	if err != nil {
		t.Errorf("parse helper descendant PID %q: %v", pidBytes, err)

		return
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		t.Errorf("find helper descendant %d: %v", pid, err)

		return
	}

	if err := process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Errorf("kill helper descendant %d: %v", pid, err)
	}
}

func equalStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}

	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}

	return true
}

func TestRunnerProductionLimits(t *testing.T) {
	if model.SmartctlTimeout != 10*time.Second {
		t.Fatalf("SmartctlTimeout = %s, want 10s", model.SmartctlTimeout)
	}

	if model.MaxSmartctlStdoutBytes != 1<<20 {
		t.Fatalf("MaxSmartctlStdoutBytes = %d, want %d", model.MaxSmartctlStdoutBytes, 1<<20)
	}

	if model.MaxSmartctlStderrBytes != 16<<10 {
		t.Fatalf("MaxSmartctlStderrBytes = %d, want %d", model.MaxSmartctlStderrBytes, 16<<10)
	}
}

func TestRunnerMissingBinaryReturnsFailure(t *testing.T) {
	runner := NewRunner("/path/that/does/not/exist/smartctl")
	got := runner.Scan(context.Background())

	if got.Failure != model.FailureBinaryUnavailable {
		t.Fatalf("Scan() failure = %q, want %q", got.Failure, model.FailureBinaryUnavailable)
	}
}

func TestRunnerStartAccessFailureReturnsTypedFailure(t *testing.T) {
	got := NewRunner(t.TempDir()).Scan(context.Background())

	if got.Failure != model.FailurePermissionDenied {
		t.Fatalf("Scan() failure = %q, want %q", got.Failure, model.FailurePermissionDenied)
	}
}

func TestRunnerTimeout(t *testing.T) {
	runner := newTestRunner(t, "write-hold", 0, testRunnerDeadline)
	runner.env = withHelperEnv(runner.env,
		"SMARTCTL_STDOUT_BYTES=1024",
		"SMARTCTL_STDERR_BYTES=1024",
	)
	ready := make(chan struct{})
	runner.afterOutput = func() {
		close(ready)
	}
	ctx := newControlledContext()

	defer ctx.finish(context.Canceled)

	result := make(chan model.CommandResult, 1)

	go func() {
		result <- runner.Scan(ctx)
	}()

	select {
	case <-ready:
	case <-time.After(testRunnerDeadline):
		t.Fatal("helper did not write output before timeout")
	}

	started := time.Now()

	ctx.finish(context.DeadlineExceeded)

	select {
	case got := <-result:
		if got.Failure != model.FailureTimeout {
			t.Fatalf("Scan() = %+v, want timeout failure", got)
		}

		if got.Stdout != nil || got.Stderr != nil {
			t.Fatalf("timeout retained partial output: stdout=%d bytes stderr=%d bytes", len(got.Stdout), len(got.Stderr))
		}

		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("deadline cleanup took %s, want under 1s", elapsed)
		}
	case <-time.After(time.Second):
		t.Fatal("Scan() did not reap helper after timeout")
	}
}

type controlledContext struct {
	context.Context
	done chan struct{}
	once sync.Once
	mu   sync.Mutex
	err  error
}

func newControlledContext() *controlledContext {
	return &controlledContext{Context: context.Background(), done: make(chan struct{})}
}

func (ctx *controlledContext) Deadline() (time.Time, bool) {
	return time.Time{}, false
}

func (ctx *controlledContext) Done() <-chan struct{} {
	return ctx.done
}

func (ctx *controlledContext) Err() error {
	ctx.mu.Lock()

	defer ctx.mu.Unlock()

	return ctx.err
}

func (ctx *controlledContext) finish(err error) {
	ctx.once.Do(func() {
		ctx.mu.Lock()

		ctx.err = err

		ctx.mu.Unlock()
		close(ctx.done)
	})
}
