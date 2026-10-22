package backend

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestLifecycleObserverPublishesTypedTransitions(t *testing.T) {
	var events []LifecycleEvent
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		OnLifecycle: func(event LifecycleEvent) {
			events = append(events, event)
		},
	})

	if err := runtime.ExecuteLifecycle("p", OpStarting, IntentRun,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatal(err)
	}

	if err := runtime.ExecuteLifecycle("p", OpStopping, IntentStop,
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
	var got []LifecycleEvent
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		OnLifecycle: func(event LifecycleEvent) {
			got = append(got, event)
		},
	})
	runtime.supervisor.services["p"] = &serviceRecord{}

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
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun,
			func(context.Context, LifecycleControl) error {
				<-block

				return nil
			})
	}()

	waitForOperation(t, runtime, "p", OpUpdating)

	err := runtime.ExecuteLifecycle("p", OpDeleting, IntentRemove,
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
		_ = runtime.ExecuteLifecycle("p", OpStarting, IntentRun,
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
		done <- runtime.ExecuteLifecycle("p", OpDeleting, IntentRemove,
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
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun,
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
	closer := &recordingCloser{onClose: func() { closed <- "p" }}

	if _, ok := runtime.Traffic().Track(closer, "p"); !ok {
		t.Fatal("Track refused connection outside platform maintenance")
	}

	block := make(chan struct{})
	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle("p", OpUpdating, IntentRun,
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

	if got := closer.closeRecords(); len(got) != 1 {
		t.Fatalf("connection close records = %#v, want one close", got)
	}

	select {
	case pluginID := <-closed:
		t.Fatalf("tracked socket closed more than once for %q", pluginID)
	default:
	}
}

func TestRuntimeExclusiveLifecycleClosesTrackedSockets(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	pCloser := &recordingCloser{}
	qCloser := &recordingCloser{}

	if _, ok := runtime.Traffic().Track(pCloser, "p"); !ok {
		t.Fatal("Track refused p outside platform maintenance")
	}

	if _, ok := runtime.Traffic().Track(qCloser, "q"); !ok {
		t.Fatal("Track refused q outside platform maintenance")
	}

	if err := runtime.ExecuteLifecycle("p", OpUpdating, IntentRun,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatal(err)
	}

	if got := pCloser.closeRecords(); len(got) != 1 {
		t.Fatalf("p close records = %#v, want one close", got)
	}

	if got := qCloser.closeRecords(); len(got) != 0 {
		t.Fatalf("q close records = %#v, want none", got)
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
