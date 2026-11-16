//go:build darwin || linux

package backend

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestShutdownTermIgnoringHelper(t *testing.T) {
	if os.Getenv("MNDW_BACKEND_IGNORE_TERM_HELPER") != "1" {
		return
	}

	term := make(chan os.Signal, 1)

	signal.Notify(term, syscall.SIGTERM)

	_, _ = fmt.Fprintln(os.Stdout, "READY")

	for {
		<-term
	}
}

func startTermIgnoringProcess(t *testing.T, waitAfterReady bool) (*exec.Cmd, *processExit, func()) {
	t.Helper()

	command := exec.Command(os.Args[0], "-test.run=^TestShutdownTermIgnoringHelper$")
	command.Env = append(os.Environ(), "MNDW_BACKEND_IGNORE_TERM_HELPER=1")
	stdout, err := command.StdoutPipe()

	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}

	configureExecCommand(command)

	if err := command.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}

	done := newProcessExit()
	waitGate := make(chan struct{})
	var startWaitOnce sync.Once
	startWait := func() {
		startWaitOnce.Do(func() { close(waitGate) })
	}

	t.Cleanup(func() {
		_ = killExecProcess(command.Process)

		startWait()

		select {
		case <-done.done:
		case <-time.After(time.Second):
			t.Errorf("helper process was not reaped")
		}
	})

	go func() {
		<-waitGate

		done.err = command.Wait()

		close(done.done)
	}()

	readyResult := make(chan error, 1)

	go func() {
		ready, readErr := bufio.NewReader(stdout).ReadString('\n')

		if readErr == nil && ready != "READY\n" {
			readErr = fmt.Errorf("unexpected readiness line %q", ready)
		}

		readyResult <- readErr
	}()

	readDeadline := time.NewTimer(time.Second)

	defer readDeadline.Stop()

	select {
	case err := <-readyResult:
		if err != nil {
			t.Fatalf("wait for helper readiness: %v", err)
		}
	case <-readDeadline.C:
		t.Fatalf("timed out waiting for helper readiness")
	}

	if waitAfterReady {
		startWait()
	}

	return command, done, startWait
}

func TestShutdownHonorsDeadlineAndReapsAllServices(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 2},
		Supervisor: SupervisorConfig{
			StopTimeout:      300 * time.Millisecond,
			FinalReapTimeout: 100 * time.Millisecond,
		},
	})
	services := make([]*exec.Cmd, 0, 2)
	dones := make([]*processExit, 0, 2)
	pluginIDs := []string{"shutdown-a", "shutdown-b"}

	for _, pluginID := range pluginIDs {
		command, done, _ := startTermIgnoringProcess(t, true)

		spec := enabledSpec(pluginID)

		seedSupervisorStateForTest(runtime.supervisor, pluginID, &spec, &serviceRecord{
			spec:        spec,
			status:      RuntimeStatus{State: StateReady},
			serviceHeld: true,
			command:     command,
			done:        done,
		}, &transition{intent: IntentRun})

		services = append(services, command)
		dones = append(dones, done)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)

	defer cancel()

	started := time.Now()
	err := runtime.Shutdown(ctx)
	elapsed := time.Since(started)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown error = %v, want context deadline exceeded", err)
	}

	if elapsed > 250*time.Millisecond {
		t.Fatalf("Shutdown took %s, want within deadline plus reap allowance", elapsed)
	}

	for index, done := range dones {
		select {
		case <-done.done:
		case <-time.After(time.Second):
			t.Fatalf("service %s was not reaped", pluginIDs[index])
		}

		if services[index].ProcessState == nil {
			t.Errorf("service %s has no ProcessState after shutdown", pluginIDs[index])
		}

		if got := runtime.Status(pluginIDs[index]).State; got != StateStopped {
			t.Errorf("service %s state = %q, want stopped", pluginIDs[index], got)
		}
	}

	if got := runtime.Limits().ReservedServices; got != 0 {
		t.Fatalf("reserved services after shutdown = %d, want 0", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
}

func TestStopProcessLogsUnreapedPID(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      20 * time.Millisecond,
			FinalReapTimeout: 20 * time.Millisecond,
			Logger:           logger,
		},
	})
	command, done, startWait := startTermIgnoringProcess(t, false)
	pluginID := "unreaped-service"
	paths, err := NewRuntimePaths(runtime.runtimeRoot, pluginID)
	if err != nil {
		t.Fatalf("runtime paths: %v", err)
	}

	seedSupervisorStateForTest(runtime.supervisor, pluginID, nil, &serviceRecord{
		spec:        enabledSpec(pluginID),
		paths:       paths,
		status:      RuntimeStatus{State: StateReady},
		serviceHeld: true,
		command:     command,
		done:        done,
	}, nil)

	stopErr := runtime.supervisor.stopProcess(context.Background(), pluginID, true)

	startWait()

	if stopErr == nil || !strings.Contains(stopErr.Error(), "did not exit after kill") {
		t.Fatalf("stop error = %v, want final-reap timeout", stopErr)
	}

	if !strings.Contains(logs.String(), fmt.Sprintf("pid=%d", command.Process.Pid)) {
		t.Fatalf("warning log = %q, want unreaped pid %d", logs.String(), command.Process.Pid)
	}
}
