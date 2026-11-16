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

func TestLifecycleAndServicePresence(t *testing.T) {
	// Lifecycle-only records and tombstones do not create service presence.
	tests := []struct {
		name        string
		op          Operation
		intent      Intent
		wantPresent bool
	}{
		{name: "absent"},
		{name: "lifecycle-only", op: OpUpdating, intent: IntentRun, wantPresent: true},
		{name: "tombstone", op: OpDeleting, intent: IntentRemove, wantPresent: true},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

			if testCase.wantPresent {
				if err := runtime.ExecuteLifecycle("p", testCase.op, testCase.intent,
					func(context.Context, LifecycleControl) error { return nil }); err != nil {
					t.Fatalf("create lifecycle record: %v", err)
				}
			}

			snapshot := runtime.supervisor.pluginSnapshot("p")
			present := snapshot.desiredPresent || snapshot.servicePresent || snapshot.transitionPresent

			if present != testCase.wantPresent {
				t.Fatalf("snapshot presence = %v, want %v", present, testCase.wantPresent)
			}

			if present && (!snapshot.transitionPresent || snapshot.servicePresent || snapshot.intent != testCase.intent) {
				t.Fatalf("lifecycle-only snapshot = %+v", snapshot)
			}

			if got := runtime.Status("p").State; got != StateStopped {
				t.Fatalf("absent-service status = %q, want %q", got, StateStopped)
			}

			if path, ok := runtime.SocketPath("p"); ok || path != "" {
				t.Fatalf("absent-service socket path = %q, %v, want empty and absent", path, ok)
			}

			if got := runtime.supervisor.runningPluginIDs(); len(got) != 0 {
				t.Fatalf("service membership for lifecycle-only record = %#v, want none", got)
			}
		})
	}
}

func TestStopAllAndShutdownObserverMembership(t *testing.T) {
	// StopAll emits no lifecycle events; shutdown observer membership follows service presence.
	var events []LifecycleEvent
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		OnLifecycle: func(event LifecycleEvent) { events = append(events, event) },
	})
	runtime.supervisor.startDesired = nil

	for _, record := range []struct {
		pluginID string
		op       Operation
		intent   Intent
	}{
		{pluginID: "lifecycle-only", op: OpUpdating, intent: IntentRun},
		{pluginID: "tombstone", op: OpDeleting, intent: IntentRemove},
	} {
		if err := runtime.ExecuteLifecycle(record.pluginID, record.op, record.intent,
			func(context.Context, LifecycleControl) error { return nil }); err != nil {
			t.Fatalf("create %s lifecycle record: %v", record.pluginID, err)
		}
	}

	if plan := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("service")}); len(plan.startIDs) != 1 {
		t.Fatalf("service start IDs = %#v, want service", plan.startIDs)
	}

	events = nil
	if err := runtime.supervisor.StopAll(context.Background()); err != nil {
		t.Fatalf("StopAll: %v", err)
	}

	if len(events) != 0 {
		t.Fatalf("StopAll emitted lifecycle events = %#v, want none", events)
	}

	for _, pluginID := range []string{"lifecycle-only", "tombstone"} {
		snapshot := runtime.supervisor.pluginSnapshot(pluginID)

		if !snapshot.transitionPresent || snapshot.servicePresent {
			t.Errorf("%s after StopAll = %+v, want lifecycle-only record retained", pluginID, snapshot)
		}
	}

	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	want := []LifecycleEvent{{Plugin: "service", State: LifecycleStopped, Reason: LifecycleReasonShutdown}}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("shutdown observer events = %#v, want service membership only: %#v", events, want)
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
