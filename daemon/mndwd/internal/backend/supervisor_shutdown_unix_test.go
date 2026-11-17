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

func seedTermIgnoringService(t *testing.T, runtime *RuntimeImpl, spec ServiceSpec) (*exec.Cmd, *processExit, func()) {
	t.Helper()

	command, done, startWait := startTermIgnoringProcess(t, false)
	paths, err := NewRuntimePaths(runtime.runtimeRoot, spec.PluginID)
	if err != nil {
		t.Fatalf("runtime paths: %v", err)
	}

	seedSupervisorStateForTest(runtime.supervisor, spec.PluginID, &spec, &serviceRecord{
		spec:        spec,
		paths:       paths,
		status:      RuntimeStatus{State: StateReady},
		serviceHeld: true,
		command:     command,
		done:        done,
	}, &transition{intent: IntentRun})

	return command, done, startWait
}

func timeoutTermIgnoringService(t *testing.T, runtime *RuntimeImpl, pluginID string) chan struct{} {
	t.Helper()

	err := runtime.supervisor.stopProcess(context.Background(), pluginID, true)
	if err == nil || !strings.Contains(err.Error(), "did not exit after kill") {
		t.Fatalf("initial stop error = %v, want final-reap timeout", err)
	}

	record := supervisorServiceForTest(runtime.supervisor, pluginID)

	if record.process == nil || record.stopDone == nil || !record.stopping {
		t.Fatal("timed-out stop did not retain process ownership")
	}

	return record.stopDone
}

func TestStopProcessJoinHonorsCallerDeadline(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      5 * time.Millisecond,
			FinalReapTimeout: 100 * time.Millisecond,
		},
	})
	spec := enabledSpec("join-stop-deadline")
	_, _, startWait := seedTermIgnoringService(t, runtime, spec)
	stopDone := timeoutTermIgnoringService(t, runtime, spec.PluginID)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)

	defer cancel()

	started := time.Now()
	err := runtime.supervisor.stopProcess(ctx, spec.PluginID, false)
	elapsed := time.Since(started)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("joining stop error = %v, want deadline exceeded", err)
	}

	if elapsed > 60*time.Millisecond {
		t.Fatalf("joining stop took %s, want it bounded by caller deadline", elapsed)
	}

	if got := runtime.Limits().ReservedServices; got != 1 {
		t.Fatalf("reserved services before exact Wait = %d, want 1", got)
	}

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop finalizer did not complete after exact Wait")
	}
}

func TestFailedStartCleanupHonorsLifetimeCancellation(t *testing.T) {
	lifetimeCtx, cancelLifetime := context.WithCancel(context.Background())
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      5 * time.Millisecond,
			FinalReapTimeout: 100 * time.Millisecond,
			LifetimeCtx:      lifetimeCtx,
		},
	})
	spec := enabledSpec("join-stop-lifetime")
	_, _, startWait := seedTermIgnoringService(t, runtime, spec)
	stopDone := timeoutTermIgnoringService(t, runtime, spec.PluginID)

	joined := make(chan struct{})

	go func() {
		runtime.supervisor.cleanupFailedStart(spec.PluginID)
		close(joined)
	}()

	cancelLifetime()

	select {
	case <-joined:
	case <-time.After(60 * time.Millisecond):
		t.Fatal("failed-start cleanup ignored supervisor lifetime cancellation")
	}

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop finalizer did not complete after exact Wait")
	}
}

func TestStopAllReturnsWhileDeferredReapWaitRemainsBlocked(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      5 * time.Millisecond,
			FinalReapTimeout: 100 * time.Millisecond,
		},
	})
	spec := enabledSpec("shutdown-joins-deferred-reap")
	_, _, startWait := seedTermIgnoringService(t, runtime, spec)
	stopDone := timeoutTermIgnoringService(t, runtime, spec.PluginID)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)

	defer cancel()

	started := time.Now()
	err := runtime.supervisor.StopAll(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("StopAll error = %v, want deadline exceeded", err)
	}

	if elapsed := time.Since(started); elapsed > 70*time.Millisecond {
		t.Fatalf("StopAll took %s while Wait remained blocked, want bounded return", elapsed)
	}

	if got := runtime.Limits().ReservedServices; got != 1 {
		t.Fatalf("reserved services before exact Wait = %d, want 1", got)
	}

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop finalizer did not complete after exact Wait")
	}
}

func TestLifecycleStartDuringDeferredStopResumesAfterReap(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      5 * time.Millisecond,
			FinalReapTimeout: 15 * time.Millisecond,
		},
	})
	plugin := testServicePlugin(t, "lifecycle-start-during-reap", nil, "backend/unused", true)
	spec, ok := runtime.serviceSpec(plugin)

	if !ok {
		t.Fatal("service plugin did not produce a spec")
	}

	_, _, startWait := seedTermIgnoringService(t, runtime, spec)
	stopDone := timeoutTermIgnoringService(t, runtime, spec.PluginID)
	started := make(chan ServiceSpec, 1)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

	if err := runtime.ExecuteLifecycle(plugin.Name, OpStarting, IntentRun,
		func(_ context.Context, control LifecycleControl) error { return control.StartPlugin(plugin) }); err != nil {
		t.Fatalf("lifecycle start = %v", err)
	}

	select {
	case got := <-started:
		t.Fatalf("lifecycle start launched before exact Wait: %+v", got)
	default:
	}

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop finalizer did not complete after exact Wait")
	}

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("resumed lifecycle start spec = %+v, want %+v", got, spec)
		}
	case <-time.After(time.Second):
		t.Fatal("same-spec lifecycle start was lost during deferred stop")
	}

	runtime.supervisor.startupWG.Wait()
}

func TestChangedSpecLifecycleStartSurvivesItsReplacementStop(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
		Supervisor: SupervisorConfig{
			StopTimeout:      5 * time.Millisecond,
			FinalReapTimeout: 15 * time.Millisecond,
		},
	})
	plugin := testServicePlugin(t, "changed-lifecycle-start-during-reap", nil, "backend/unused", true)
	oldSpec, ok := runtime.serviceSpec(plugin)

	if !ok {
		t.Fatal("service plugin did not produce an old spec")
	}

	_, _, startWait := seedTermIgnoringService(t, runtime, oldSpec)
	plugin.Dir = t.TempDir()
	newSpec, ok := runtime.serviceSpec(plugin)

	if !ok {
		t.Fatal("service plugin did not produce a replacement spec")
	}

	started := make(chan ServiceSpec, 2)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

	if err := runtime.ExecuteLifecycle(plugin.Name, OpStarting, IntentRun,
		func(_ context.Context, control LifecycleControl) error { return control.StartPlugin(plugin) }); err == nil {
		t.Fatal("changed-spec lifecycle start returned nil after replacement stop timed out")
	}

	if runtime.operationOf(plugin.Name) != OpNone {
		t.Fatalf("lifecycle operation = %v, want terminalized", runtime.operationOf(plugin.Name))
	}

	record := supervisorServiceForTest(runtime.supervisor, plugin.Name)

	if record.process == nil || record.stopDone == nil || !record.stopping {
		t.Fatal("replacement stop timeout did not retain old process ownership")
	}

	stopDone := record.stopDone

	for attempt := 0; attempt < 2; attempt++ {
		plan := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{newSpec})

		if len(plan.startIDs) != 0 {
			t.Fatalf("reconcile during replacement stop planned starts = %v, want none", plan.startIDs)
		}
	}

	select {
	case got := <-started:
		t.Fatalf("replacement launched before exact Wait: %+v", got)
	default:
	}

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("replacement stop finalizer did not complete after exact Wait")
	}

	select {
	case got := <-started:
		if !got.Equal(newSpec) {
			t.Fatalf("resumed lifecycle start spec = %+v, want %+v", got, newSpec)
		}
	case <-time.After(time.Second):
		t.Fatal("changed-spec lifecycle start was lost during its replacement stop")
	}

	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("replacement launched more than once: %+v", got)
	default:
	}
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

		waitForSupervisorStopForTest(t, runtime.supervisor, pluginIDs[index])

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

	if stopErr == nil || !strings.Contains(stopErr.Error(), "did not exit after kill") {
		t.Fatalf("stop error = %v, want final-reap timeout", stopErr)
	}

	if got := runtime.Limits().ReservedServices; got != 1 {
		t.Fatalf("reserved services before exact Wait = %d, want 1", got)
	}

	current := supervisorServiceForTest(runtime.supervisor, pluginID)

	if current.process == nil || current.process.command != command || current.process.exit != done || current.stopDone == nil {
		t.Fatal("timed-out stop released process ownership before exact Wait")
	}

	stopDone := current.stopDone

	startWait()

	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop finalizer did not complete after exact Wait")
	}

	if got := runtime.Limits().ReservedServices; got != 0 {
		t.Fatalf("reserved services after exact Wait = %d, want 0", got)
	}

	if !strings.Contains(logs.String(), fmt.Sprintf("pid=%d", command.Process.Pid)) {
		t.Fatalf("warning log = %q, want unreaped pid %d", logs.String(), command.Process.Pid)
	}
}
