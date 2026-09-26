package backend

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestLifecycleObserverPublishesTypedTransitions(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	var events []LifecycleEvent

	runtime.SetLifecycleObserver(func(event LifecycleEvent) {
		events = append(events, event)
	})

	if err := runtime.ExecuteLifecycle("p", OpStarting, IntentRun, TerminalRun, FailRestore,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatal(err)
	}

	if err := runtime.ExecuteLifecycle("p", OpStopping, IntentStop, TerminalStop, FailKeep,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatal(err)
	}

	want := []LifecycleEvent{
		{Plugin: "p", State: LifecycleStarted, Reason: LifecycleReasonReconciled},
		{Plugin: "p", State: LifecycleStopped, Reason: LifecycleReasonDisabled},
	}

	if !reflect.DeepEqual(events, want) {
		t.Fatalf("lifecycle events = %#v, want %#v", events, want)
	}
}

func TestRuntimeShutdownPublishesTypedReason(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	runtime.supervisor.services["p"] = &serviceRecord{}
	var got []LifecycleEvent

	runtime.SetLifecycleObserver(func(event LifecycleEvent) {
		got = append(got, event)
	})

	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	want := []LifecycleEvent{{Plugin: "p", State: LifecycleStopped, Reason: LifecycleReasonShutdown}}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shutdown events = %#v, want %#v", got, want)
	}
}

func TestExecuteLifecycleConflictSurfaces(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	block := make(chan struct{})
	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun, TerminalRun, FailRestore,
			func(context.Context, LifecycleControl) error {
				<-block

				return nil
			})
	}()

	waitForOperation(t, runtime, "p", OpUpdating)

	err := runtime.ExecuteLifecycle("p", OpDeleting, IntentRemove, TerminalRemove, FailRemoved,
		func(context.Context, LifecycleControl) error { return nil })

	if !errors.Is(err, ErrLifecycleConflict) {
		t.Fatalf("delete during update = %v, want ErrLifecycleConflict", err)
	}

	close(block)

	if err := <-done; err != nil {
		t.Fatalf("update = %v", err)
	}
}

func TestSupersededWorkQuiescesBeforeCleanup(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	entered := make(chan struct{})
	loserQuiesced := make(chan struct{})

	go func() {
		_ = runtime.ExecuteLifecycle("p", OpStarting, IntentRun, TerminalRun, FailRestore,
			func(ctx context.Context, _ LifecycleControl) error {
				close(entered)
				<-ctx.Done()
				close(loserQuiesced)

				return ctx.Err()
			})
	}()

	<-entered

	cleanupRan := make(chan struct{})
	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle("p", OpDeleting, IntentRemove, TerminalRemove, FailRemoved,
			func(context.Context, LifecycleControl) error {
				select {
				case <-loserQuiesced:
				default:
					t.Error("cleanup ran before superseded work quiesced")
				}

				close(cleanupRan)

				return nil
			})
	}()

	select {
	case <-cleanupRan:
	case <-time.After(2 * time.Second):
		t.Fatal("cleanup did not run")
	}

	if err := <-done; err != nil {
		t.Fatalf("delete = %v", err)
	}
}

func TestWorkPanicTerminalizesRun(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun, TerminalRun, FailRestore,
			func(context.Context, LifecycleControl) error { panic("boom") })
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("panic returned nil")
		}
	case <-time.After(time.Second):
		t.Fatal("panic stranded lifecycle waiter")
	}

	if got := runtime.operationOf("p"); got != OpNone {
		t.Fatalf("operation after panic = %v, want OpNone", got)
	}

	if got := runtime.intentOf("p"); got != IntentRemove {
		t.Fatalf("intent after panic = %v, want restored remove", got)
	}
}

func TestAcceptedExclusiveLifecycleClosesSocketsOnceAndGatesTraffic(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	closed := make(chan string, 1)

	runtime.SetLifecycleHooks(func(pluginID string) { closed <- pluginID })

	block := make(chan struct{})
	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun, TerminalRun, FailRestore,
			func(context.Context, LifecycleControl) error {
				<-block

				return nil
			})
	}()

	waitForOperation(t, runtime, "p", OpUpdating)

	if !runtime.BlocksTraffic("p") {
		t.Fatal("update did not gate traffic")
	}

	select {
	case got := <-closed:
		if got != "p" {
			t.Fatalf("closed plugin = %q, want p", got)
		}
	case <-time.After(time.Second):
		t.Fatal("exclusive transition did not close sockets")
	}

	close(block)

	if err := <-done; err != nil {
		t.Fatalf("update = %v", err)
	}

	if runtime.BlocksTraffic("p") {
		t.Fatal("successful update left traffic gated")
	}

	select {
	case pluginID := <-closed:
		t.Fatalf("socket hook called more than once for %q", pluginID)
	default:
	}
}

func TestBlocksTrafficDoesNotGatePluginsWithoutLifecycleRecord(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

	if runtime.BlocksTraffic("static-or-exec") {
		t.Fatal("absent lifecycle record gated unrelated plugin traffic")
	}
}

func waitForOperation(t *testing.T, runtime *RuntimeImpl, pluginID string, operation Operation) {
	t.Helper()

	deadline := time.After(time.Second)
	ticker := time.NewTicker(time.Millisecond)

	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			t.Fatalf("operation = %v, want %v", runtime.operationOf(pluginID), operation)
		case <-ticker.C:
			if runtime.operationOf(pluginID) == operation {
				return
			}
		}
	}
}
