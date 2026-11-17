package backend

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"mndwd/internal/registry"
	"mndwd/internal/state"
)

func TestLifecycleRunsForDifferentPluginsDoNotSerialize(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)

	go func() {
		firstDone <- runtime.ExecuteLifecycle("first", OpUpdating, IntentRun,
			func(context.Context, LifecycleControl) error {
				close(firstEntered)
				<-releaseFirst

				return nil
			})
	}()

	<-firstEntered

	if err := runtime.ExecuteLifecycle("second", OpInstalling, IntentRun,
		func(context.Context, LifecycleControl) error { return nil }); err != nil {
		t.Fatalf("independent lifecycle = %v", err)
	}

	close(releaseFirst)

	if err := <-firstDone; err != nil {
		t.Fatalf("first lifecycle = %v", err)
	}
}

func TestReconcileStartupFailureTerminalizes(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	plugin := testServicePlugin(t, "missing", nil, "backend/does-not-exist", true)

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForLifecycleAttempt(t, runtime, plugin.Name)

	if got := runtime.operationOf(plugin.Name); got != OpNone {
		t.Fatalf("failed startup operation = %v, want OpNone", got)
	}

	if got := runtime.intentOf(plugin.Name); got != IntentRun {
		t.Fatalf("failed startup intent = %v, want IntentRun", got)
	}

	if got := runtime.Status(plugin.Name).State; got != StateBackoff {
		t.Fatalf("failed startup state = %q, want backoff", got)
	}
}

func TestReconcileAdmitsBuiltinsBeforeUserServices(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 3},
	})

	plugins := []*registry.Plugin{
		testServicePlugin(t, "user-c", nil, "backend/missing", true),
		testServicePlugin(t, "builtin-z", nil, "backend/missing", true),
		testServicePlugin(t, "user-a", nil, "backend/missing", true),
		testServicePlugin(t, "builtin-a", nil, "backend/missing", true),
		testServicePlugin(t, "user-b", nil, "backend/missing", true),
	}

	for _, plugin := range plugins {
		if plugin.Name == "builtin-a" || plugin.Name == "builtin-z" {
			plugin.Source = state.SourceBuiltin
		}
	}

	runtime.Reconcile(context.Background(), plugins)

	for _, pluginID := range []string{"builtin-a", "builtin-z", "user-a"} {
		waitForLifecycleAttempt(t, runtime, pluginID)

		if got := runtime.Status(pluginID).State; got != StateBackoff {
			t.Errorf("%s state = %q, want %q", pluginID, got, StateBackoff)
		}
	}

	for _, pluginID := range []string{"user-b", "user-c"} {
		if got := runtime.Status(pluginID).State; got != StateCapacityBlocked {
			t.Errorf("%s state = %q, want %q", pluginID, got, StateCapacityBlocked)
		}
	}

	if got := runtime.Limits().ReservedServices; got != 3 {
		t.Fatalf("reserved service slots = %d, want 3", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
}

func TestLifecycleReleasesReservationWhenStartupDoesNotLaunch(t *testing.T) {
	t.Run("initially admitted", func(t *testing.T) {
		runtime := NewRuntime(RuntimeConfig{
			RuntimeRoot: t.TempDir(),
			Limits:      Limits{MaxSupervisedServices: 1},
		})
		plugin := testServicePlugin(t, "never-started", nil, "backend/missing", true)
		spec, ok := runtime.serviceSpec(plugin)

		if !ok {
			t.Fatal("service plugin did not produce a spec")
		}

		plan := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{spec})

		if len(plan.startIDs) != 1 || plan.startIDs[0] != plugin.Name {
			t.Fatalf("start IDs = %#v, want [%q]", plan.startIDs, plugin.Name)
		}

		if got := runtime.Limits().ReservedServices; got != 1 {
			t.Fatalf("reserved services before lifecycle = %d, want 1", got)
		}

		outcome := runtime.supervisor.beginDesiredStartup(spec)

		if outcome.conflict {
			t.Fatal("desired startup conflicted")
		}

		if err := runtime.executeLifecycleOutcome(plugin.Name, OpStarting,
			func(context.Context, LifecycleControl) error { return nil }, outcome); err != nil {
			t.Fatalf("startup lifecycle = %v", err)
		}

		if got := runtime.Limits().ReservedServices; got != 0 {
			t.Fatalf("reserved services after unused startup = %d, want 0", got)
		}

		if got := runtime.Status(plugin.Name).State; got != StateStopped {
			t.Fatalf("service state after unused startup = %q, want stopped", got)
		}

		assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
	})

	t.Run("promoted service releases its slot for the next waiter", func(t *testing.T) {
		runtime := NewRuntime(RuntimeConfig{
			RuntimeRoot: t.TempDir(),
			Limits:      Limits{MaxSupervisedServices: 1},
		})
		runtime.supervisor.startDesired = func(ServiceSpec) {}

		specs := []ServiceSpec{enabledSpec("first"), enabledSpec("second"), enabledSpec("third")}
		plan := runtime.supervisor.Reconcile(context.Background(), specs)

		if len(plan.startIDs) != 1 || plan.startIDs[0] != "first" {
			t.Fatalf("initial start IDs = %#v, want [first]", plan.startIDs)
		}

		for _, pluginID := range []string{"second", "third"} {
			if got := runtime.Status(pluginID).State; got != StateCapacityBlocked {
				t.Fatalf("%s initial state = %q, want %q", pluginID, got, StateCapacityBlocked)
			}
		}

		if err := runtime.supervisor.stopRecord(context.Background(), "first"); err != nil {
			t.Fatalf("release first service slot: %v", err)
		}

		secondSpec := enabledSpec("second")
		outcome := runtime.supervisor.beginDesiredStartup(secondSpec)

		if outcome.conflict {
			t.Fatal("promoted startup conflicted")
		}

		if err := runtime.executeLifecycleOutcome("second", OpStarting,
			func(context.Context, LifecycleControl) error { return nil }, outcome); err != nil {
			t.Fatalf("promoted startup lifecycle = %v", err)
		}

		if got := runtime.Status("second").State; got != StateStopped {
			t.Fatalf("unused promoted service state = %q, want stopped", got)
		}

		if got := runtime.Status("third").State; got != StateCapacityBlocked {
			t.Fatalf("next promoted service state = %q, want %q", got, StateCapacityBlocked)
		}

		if got := runtime.Limits().ReservedServices; got != 1 {
			t.Fatalf("reserved services after next promotion = %d, want 1", got)
		}

		assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
	})
}

func TestPromotedServiceQueuedBehindStartupProjectsAsStarting(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 2},
	})
	runtime.supervisor.startDesired = nil

	specs := []ServiceSpec{
		enabledSpec("service-a"),
		enabledSpec("service-b"),
		enabledSpec("service-c"),
		enabledSpec("service-d"),
	}
	plan := runtime.supervisor.Reconcile(context.Background(), specs)

	if len(plan.startIDs) != 2 || plan.startIDs[0] != "service-a" || plan.startIDs[1] != "service-b" {
		t.Fatalf("initial start IDs = %#v, want [service-a service-b]", plan.startIDs)
	}

	for _, pluginID := range []string{"service-a", "service-b"} {
		if err := runtime.supervisor.stopRecord(context.Background(), pluginID); err != nil {
			t.Fatalf("release %s service slot: %v", pluginID, err)
		}
	}

	firstStartupEntered := make(chan struct{})
	releaseFirstStartup := make(chan struct{})
	firstStartupFinished := make(chan struct{})
	secondStartupEntered := make(chan struct{})
	releaseSecondStartup := make(chan struct{})
	secondStartupFinished := make(chan struct{})
	promotedDone := make(chan struct{})
	queuedStartPlan := make(chan startPlanSnapshot, 1)
	runtime.supervisor.startDesired = func(spec ServiceSpec) {
		if spec.PluginID == "service-c" {
			close(firstStartupEntered)
			<-releaseFirstStartup
			close(firstStartupFinished)

			return
		}

		close(secondStartupEntered)
		<-releaseSecondStartup

		queuedStartPlan <- runtime.supervisor.planStart(spec, RuntimePaths{})

		close(secondStartupFinished)
	}

	go func() {
		runtime.supervisor.promoteBlocked()
		close(promotedDone)
	}()

	defer func() {
		select {
		case <-releaseFirstStartup:
		default:
			close(releaseFirstStartup)
		}

		select {
		case <-releaseSecondStartup:
		default:
			close(releaseSecondStartup)
		}

		select {
		case <-promotedDone:
		case <-time.After(time.Second):
			t.Error("blocked service promotion did not finish")
		}
	}()

	select {
	case <-firstStartupEntered:
	case <-time.After(time.Second):
		t.Fatal("first promoted startup did not reach its wait point")
	}

	select {
	case <-secondStartupEntered:
	case <-time.After(time.Second):
		t.Fatal("second promoted startup did not dispatch while first startup was blocked")
	}

	runtime.supervisor.Reconcile(context.Background(), specs)

	fourth := testServicePlugin(t, "service-d", nil, "backend/missing", true)
	gateway := &Gateway{runtime: runtime, traffic: runtime.Traffic(), activationGates: runtime.activationGates}
	status := gateway.projectBackendStatus(fourth, runtime.Now())

	if got := runtime.Status("service-d").State; got != StateCapacityBlocked {
		t.Fatalf("queued promoted service runtime state = %q, want %q", got, StateCapacityBlocked)
	}

	if status.State != "starting" {
		t.Fatalf("queued promoted service public state = %q, want starting", status.State)
	}

	if got := runtime.Limits().ReservedServices; got != 2 {
		t.Fatalf("reserved slots while second startup is queued = %d, want 2", got)
	}

	close(releaseSecondStartup)

	select {
	case queuedPlan := <-queuedStartPlan:
		if queuedPlan.action != startProceed {
			t.Fatalf("queued promoted start action = %v, want startProceed", queuedPlan.action)
		}
	case <-time.After(time.Second):
		t.Fatal("queued promoted startup did not produce a start plan")
	}

	if got := runtime.Limits().ReservedServices; got != 2 {
		t.Fatalf("reserved slots after queued start planning = %d, want 2", got)
	}

	if got := runtime.Status("service-d").State; got != StateStarting {
		t.Fatalf("queued promoted service state after planning = %q, want %q", got, StateStarting)
	}

	close(releaseFirstStartup)

	for _, finished := range []<-chan struct{}{firstStartupFinished, secondStartupFinished, promotedDone} {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("promoted startup callback did not finish")
		}
	}

	assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
}

func TestPromotedBlockedReservationSurvivesRepeatedReconcileAndReleasesOnce(t *testing.T) {
	// A promoted service keeps its reserved slot while blocked, until startup is superseded or removed.
	tests := []struct {
		name   string
		remove bool
	}{
		{name: "superseded"},
		{name: "removed", remove: true},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := NewRuntime(RuntimeConfig{
				RuntimeRoot: t.TempDir(),
				Limits:      Limits{MaxSupervisedServices: 1},
			})
			releaseSecond := make(chan struct{})
			secondEntered := make(chan struct{}, 1)
			var releaseOnce sync.Once
			release := func() {
				releaseOnce.Do(func() { close(releaseSecond) })
			}

			t.Cleanup(func() {
				release()

				waited := make(chan struct{})

				go func() {
					runtime.supervisor.startupWG.Wait()
					close(waited)
				}()

				select {
				case <-waited:
				case <-time.After(time.Second):
					t.Error("startup callbacks did not drain during cleanup")
				}
			})

			runtime.supervisor.startDesired = func(spec ServiceSpec) {
				if spec.PluginID != "second" {
					return
				}

				select {
				case secondEntered <- struct{}{}:
				default:
				}

				<-releaseSecond
			}

			specs := []ServiceSpec{enabledSpec("first"), enabledSpec("second")}
			plan := runtime.supervisor.Reconcile(context.Background(), specs)

			if len(plan.startIDs) != 1 || plan.startIDs[0] != "first" {
				t.Fatalf("initial start IDs = %#v, want [first]", plan.startIDs)
			}

			if got := runtime.Status("second").State; got != StateCapacityBlocked {
				t.Fatalf("second initial state = %q, want %q", got, StateCapacityBlocked)
			}

			if err := runtime.supervisor.stopRecord(context.Background(), "first"); err != nil {
				t.Fatalf("release first service slot: %v", err)
			}

			select {
			case <-secondEntered:
			case <-time.After(time.Second):
				t.Fatal("promoted startup did not reach its wait point")
			}

			assertPendingReservation := func() {
				t.Helper()

				snapshot := runtime.supervisor.pluginSnapshot("second")

				if !snapshot.servicePresent || snapshot.status.State != StateCapacityBlocked || !snapshot.serviceSlotHeld || !snapshot.reservationPending {
					t.Fatalf("promoted reservation snapshot = %+v, want blocked service with pending owned slot", snapshot)
				}

				if !snapshot.startupQueued || snapshot.startupSeq != 1 {
					t.Fatalf("promoted startup queue = queued %v sequence %d, want one queued startup", snapshot.startupQueued, snapshot.startupSeq)
				}

				if got := runtime.Limits().ReservedServices; got != 1 {
					t.Fatalf("reserved slots while startup is paused = %d, want 1", got)
				}
			}

			assertPendingReservation()

			repeated := runtime.supervisor.Reconcile(context.Background(), specs)

			if !containsID(repeated.startIDs, "second") {
				t.Fatalf("repeated reconcile start IDs = %#v, want second candidate", repeated.startIDs)
			}

			for _, pluginID := range repeated.startIDs {
				runtime.supervisor.launchDesiredStartup(enabledSpec(pluginID))
			}

			runtime.supervisor.promoteBlocked()
			assertPendingReservation()

			if testCase.remove {
				removed := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("first")})

				if !containsID(removed.removeIDs, "second") {
					t.Fatalf("remove plan = %+v, want second", removed)
				}
			} else {
				disabled := enabledSpec("second")
				disabled.Enabled = false
				superseded := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("first"), disabled})

				if !containsID(superseded.stopIDs, "second") {
					t.Fatalf("supersede plan = %+v, want second stop", superseded)
				}
			}

			if err := runtime.supervisor.stopRecord(context.Background(), "second"); err != nil {
				t.Fatalf("release second service slot: %v", err)
			}

			second := runtime.supervisor.pluginSnapshot("second")

			if second.serviceSlotHeld || second.reservationPending || second.status.State != StateStopped {
				t.Fatalf("second after cleanup = %+v, want stopped with no reservation", second)
			}

			first := runtime.supervisor.pluginSnapshot("first")

			if !first.serviceSlotHeld {
				t.Fatalf("first promoted snapshot = %+v, want it to own released slot", first)
			}

			if got := runtime.Limits().ReservedServices; got != 1 {
				t.Fatalf("reserved slots after promotion = %d, want 1", got)
			}

			if err := runtime.supervisor.stopRecord(context.Background(), "second"); err != nil {
				t.Fatalf("repeat second cleanup: %v", err)
			}

			if got := runtime.Limits().ReservedServices; got != 1 {
				t.Fatalf("reserved slots after repeated cleanup = %d, want first service's single slot", got)
			}

			assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
		})
	}
}

func TestDirectStartupWinsBeforeRetryTimerWithoutDuplicate(t *testing.T) {
	// Direct startup owns the transition before retry eligibility, so the timer cannot queue another start.
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
	})
	spec := enabledSpec("retry")

	if plan := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{spec}); len(plan.startIDs) != 1 {
		t.Fatalf("initial start IDs = %#v, want one candidate", plan.startIDs)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	startCalls := make(chan struct{}, 2)
	retryCallbackDone := make(chan struct{}, 1)
	runtime.supervisor.retryCallbackDone = func(pluginID string) {
		if pluginID == spec.PluginID {
			retryCallbackDone <- struct{}{}
		}
	}
	var releaseOnce sync.Once
	closeRelease := func() {
		releaseOnce.Do(func() { close(release) })
	}

	t.Cleanup(func() {
		closeRelease()

		waited := make(chan struct{})

		go func() {
			runtime.supervisor.startupWG.Wait()
			close(waited)
		}()

		select {
		case <-waited:
		case <-time.After(time.Second):
			t.Error("startup callback did not drain during cleanup")
		}
	})

	finished := make(chan error, 1)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) {
		startCalls <- struct{}{}
		outcome := runtime.supervisor.beginDesiredStartup(startSpec)

		if outcome.conflict {
			return
		}

		close(entered)
		<-release

		finished <- runtime.executeLifecycleOutcome(startSpec.PluginID, OpStarting,
			func(context.Context, LifecycleControl) error { return nil }, outcome)
	}

	setSupervisorServiceStateForTest(runtime.supervisor, spec.PluginID, StateBackoff)
	runtime.supervisor.launchDesiredStartup(spec)

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("direct startup did not begin before retry timer")
	}

	select {
	case <-startCalls:
	default:
		t.Fatal("direct startup callback was not observed")
	}

	const retryDelay = 10 * time.Millisecond

	scheduleSupervisorRetryForTest(runtime.supervisor, spec.PluginID, retryDelay)

	select {
	case <-retryCallbackDone:
	case <-time.After(time.Second):
		t.Fatal("retry callback did not complete")
	}

	if runtime.supervisor.pluginSnapshot(spec.PluginID).retryTimerPresent {
		t.Error("retry timer remained scheduled after its callback completed")
	}

	if got := runtime.supervisor.pluginSnapshot(spec.PluginID).startupSeq; got != 1 {
		t.Fatalf("startup sequence after retry callback = %d, want one direct startup", got)
	}

	select {
	case <-startCalls:
		t.Fatal("retry callback queued another startup")
	default:
	}

	closeRelease()

	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("direct startup lifecycle = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("direct startup did not finish after release")
	}

	waited := make(chan struct{})

	go func() {
		runtime.supervisor.startupWG.Wait()
		close(waited)
	}()

	select {
	case <-waited:
	case <-time.After(time.Second):
		t.Fatal("startup callbacks did not drain")
	}

}

func TestRetryTimerBeforeRegisteredProcessExitKeepsRetryPending(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
	spec := enabledSpec("timer-before-exit")
	done := newProcessExit()

	seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateBackoff}, &exec.Cmd{}, done)

	started := make(chan ServiceSpec, 2)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }
	callbackDone := make(chan struct{}, 1)
	runtime.supervisor.retryCallbackDone = func(string) { callbackDone <- struct{}{} }

	scheduleSupervisorRetryForTest(runtime.supervisor, spec.PluginID, time.Nanosecond)

	select {
	case <-callbackDone:
	case <-time.After(time.Second):
		t.Fatal("retry timer callback did not complete")
	}

	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("retry launched before exact Wait completed: %+v", got)
	default:
	}

	done.err = errors.New("old process exited")

	close(done.done)
	runtime.supervisor.observeExit(spec.PluginID, done)

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("retry spec = %+v, want %+v", got, spec)
		}
	case <-time.After(time.Second):
		t.Fatal("retry was lost after the exact Wait completed")
	}

	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("retry launched more than once: %+v", got)
	default:
	}
}

func TestRegisteredProcessExitBeforeRetryTimerLaunchesOnce(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
	spec := enabledSpec("exit-before-timer")
	done := newProcessExit()

	seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateReady}, &exec.Cmd{}, done)

	started := make(chan ServiceSpec, 2)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }
	callbackDone := make(chan struct{}, 1)
	runtime.supervisor.retryCallbackDone = func(string) { callbackDone <- struct{}{} }
	done.err = errors.New("old process exited")

	close(done.done)
	runtime.supervisor.observeExit(spec.PluginID, done)
	scheduleSupervisorRetryForTest(runtime.supervisor, spec.PluginID, time.Nanosecond)

	select {
	case <-callbackDone:
	case <-time.After(time.Second):
		t.Fatal("retry timer callback did not complete")
	}

	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("retry spec = %+v, want %+v", got, spec)
		}
	default:
		t.Fatal("retry did not launch after the process exit")
	}

	select {
	case got := <-started:
		t.Fatalf("retry launched more than once: %+v", got)
	default:
	}
}

func TestDirectDesiredStartDuringRegisteredProcessReapRunsAfterExit(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
	spec := enabledSpec("direct-during-reap")
	done := newProcessExit()

	seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateBackoff}, &exec.Cmd{}, done)

	started := make(chan ServiceSpec, 2)
	runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

	runtime.supervisor.launchDesiredStartup(spec)
	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("direct start launched before exact Wait completed: %+v", got)
	default:
	}

	done.err = errors.New("old process exited")

	close(done.done)
	runtime.supervisor.observeExit(spec.PluginID, done)

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("direct start spec = %+v, want %+v", got, spec)
		}
	case <-time.After(time.Second):
		t.Fatal("direct start was lost while the old process was being reaped")
	}

	runtime.supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("direct start launched more than once: %+v", got)
	default:
	}
}

func TestDesiredOrIntentChangeDuringRegisteredProcessReap(t *testing.T) {
	t.Run("changed desired spec starts after reap", func(t *testing.T) {
		runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
		oldSpec := enabledSpec("desired-during-reap")
		oldSpec.Command = "backend/old"
		done := newProcessExit()

		seedRegisteredServiceForTest(runtime.supervisor, oldSpec, RuntimeStatus{State: StateReady}, &exec.Cmd{}, done)

		started := make(chan ServiceSpec, 2)
		runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

		newSpec := oldSpec
		newSpec.Command = "backend/new"
		plan := runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{newSpec})

		if len(plan.startIDs) != 1 || plan.startIDs[0] != oldSpec.PluginID {
			t.Fatalf("replacement request IDs while old process is owned = %#v, want one replacement request", plan.startIDs)
		}

		if startPlan := runtime.supervisor.planStart(newSpec, RuntimePaths{}); startPlan.action != startReplace {
			t.Fatalf("replacement start action while old process is owned = %d, want stop-before-replace", startPlan.action)
		}

		select {
		case got := <-started:
			t.Fatalf("replacement launched before exact Wait completed: %+v", got)
		default:
		}

		done.err = errors.New("old process exited")

		close(done.done)
		runtime.supervisor.observeExit(oldSpec.PluginID, done)

		select {
		case got := <-started:
			if !got.Equal(newSpec) {
				t.Fatalf("replacement spec = %+v, want %+v", got, newSpec)
			}
		case <-time.After(time.Second):
			t.Fatal("changed desired service did not launch after reap")
		}

		runtime.supervisor.startupWG.Wait()
	})

	t.Run("stop intent suppresses pending direct start", func(t *testing.T) {
		runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
		spec := enabledSpec("intent-during-reap")
		done := newProcessExit()

		seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateBackoff}, &exec.Cmd{}, done)

		started := make(chan ServiceSpec, 2)
		runtime.supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

		runtime.supervisor.launchDesiredStartup(spec)

		disabled := spec
		disabled.Enabled = false

		runtime.supervisor.Reconcile(context.Background(), []ServiceSpec{disabled})
		runtime.supervisor.startupWG.Wait()

		select {
		case got := <-started:
			t.Fatalf("direct start launched before stop intent: %+v", got)
		default:
		}

		done.err = errors.New("old process exited")

		close(done.done)
		runtime.supervisor.observeExit(spec.PluginID, done)
		runtime.supervisor.startupWG.Wait()

		select {
		case got := <-started:
			t.Fatalf("pending start survived stop intent: %+v", got)
		default:
		}
	})
}

func TestOldProcessExitCannotMutateNewRegisteredProcess(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}})
	spec := enabledSpec("old-process-identity")
	oldExit := newProcessExit()
	oldExit.err = errors.New("old process exited")

	close(oldExit.done)

	oldCommand := &exec.Cmd{}

	seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateReady}, oldCommand, oldExit)

	oldRecord := supervisorServiceForTest(runtime.supervisor, spec.PluginID)
	oldProcess := oldRecord.process
	newCommand := &exec.Cmd{}
	newExit := newProcessExit()

	seedRegisteredServiceForTest(runtime.supervisor, spec, RuntimeStatus{State: StateReady}, newCommand, newExit)

	currentBeforeExit := supervisorServiceForTest(runtime.supervisor, spec.PluginID)

	if currentBeforeExit.process == nil || currentBeforeExit.process.id <= oldProcess.id {
		t.Fatal("new registered process did not receive a newer immutable identity")
	}

	runtime.supervisor.observeProcessExit(spec.PluginID, oldProcess)

	current := supervisorServiceForTest(runtime.supervisor, spec.PluginID)

	if current.process == nil || current.process.command != newCommand || current.process.exit != newExit {
		t.Fatal("old process exit replaced the current process identity")
	}

	if current.status.State != StateReady {
		t.Fatalf("new process status after stale exit = %q, want ready", current.status.State)
	}

	if got := runtime.supervisor.reservedServiceCount(); got != 1 {
		t.Fatalf("reserved service slots after stale exit = %d, want 1", got)
	}
}

func seedRegisteredServiceForTest(
	s *Supervisor,
	spec ServiceSpec,
	status RuntimeStatus,
	command *exec.Cmd,
	done *processExit,
) {
	seedSupervisorStateForTest(s, spec.PluginID, &spec, &serviceRecord{
		spec:        spec,
		status:      status,
		serviceHeld: true,
		command:     command,
		done:        done,
	}, &transition{intent: IntentRun, operation: OpNone})
}

func TestDisableDoesNotWaitForPromotedServiceReadiness(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      Limits{MaxSupervisedServices: 1},
	})
	specs := []ServiceSpec{enabledSpec("service-a"), enabledSpec("service-b")}
	plan := runtime.supervisor.Reconcile(context.Background(), specs)

	if len(plan.startIDs) != 1 || plan.startIDs[0] != "service-a" {
		t.Fatalf("initial start IDs = %#v, want [service-a]", plan.startIDs)
	}

	setSupervisorServiceStateForTest(runtime.supervisor, "service-a", StateReady)

	promotedRecord := supervisorServiceForTest(runtime.supervisor, "service-b")

	readinessEntered := make(chan struct{})
	readinessRelease := make(chan struct{})
	promotedDone := make(chan error, 1)
	var releaseOnce sync.Once
	releaseReadiness := func() {
		releaseOnce.Do(func() { close(readinessRelease) })
	}
	promotedFinished := false

	defer func() {
		releaseReadiness()

		if !promotedFinished {
			select {
			case <-promotedDone:
			case <-time.After(time.Second):
				t.Error("promoted service startup did not finish during cleanup")
			}
		}
	}()

	runtime.supervisor.startDesired = func(spec ServiceSpec) {
		outcome := runtime.supervisor.beginDesiredStartup(spec)

		if outcome.conflict {
			promotedDone <- ErrLifecycleConflict

			return
		}

		promotedDone <- runtime.executeLifecycleOutcome(spec.PluginID, OpStarting,
			func(_ context.Context, control LifecycleControl) error {
				setSupervisorServiceStateForTest(runtime.supervisor, spec.PluginID, StateStarting)
				close(readinessEntered)
				<-readinessRelease

				if !markLifecycleServiceReady(control, promotedRecord) {
					return errSuperseded
				}

				return nil
			}, outcome)
	}

	disableDone := make(chan error, 1)

	go func() {
		disableDone <- runtime.ExecuteLifecycle("service-a", OpStopping, IntentStop,
			func(_ context.Context, control LifecycleControl) error { return control.StopService() })
	}()

	select {
	case <-readinessEntered:
	case <-time.After(time.Second):
		t.Fatal("promoted service did not enter readiness")
	}

	select {
	case err := <-disableDone:
		if err != nil {
			t.Fatalf("disable service-a: %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("disable waited for promoted service readiness")
	}

	releaseReadiness()

	select {
	case err := <-promotedDone:
		promotedFinished = true

		if err != nil {
			t.Fatalf("promoted service startup: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("promoted service did not finish after readiness was released")
	}

	if got := runtime.Status("service-b").State; got != StateReady {
		t.Fatalf("promoted service state = %q, want ready", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, runtime.supervisor)
}

func TestDeleteWinsOverSlowStartupIntegration(t *testing.T) {
	runtime, plugin := slowStartupRuntime(t, "slow")

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForOperation(t, runtime, plugin.Name, OpStarting)

	done := make(chan error, 1)

	go func() {
		done <- runtime.ExecuteLifecycle(plugin.Name, OpDeleting, IntentRemove,
			func(_ context.Context, control LifecycleControl) error { return control.StopService() })
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("delete = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("delete blocked behind slow startup")
	}

	if got := runtime.Status(plugin.Name).State; got != StateStopped {
		t.Fatalf("service after delete = %q, want stopped", got)
	}
}

func TestRepeatedReconcileDoesNotDuplicateStartingRun(t *testing.T) {
	runtime, plugin := slowStartupRuntime(t, "repeat")

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForOperation(t, runtime, plugin.Name, OpStarting)

	firstGeneration := runtime.generationOf(plugin.Name)

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})

	if got := runtime.generationOf(plugin.Name); got != firstGeneration {
		t.Fatalf("generation after repeated reconcile = %d, want %d", got, firstGeneration)
	}

	if err := runtime.ExecuteLifecycle(plugin.Name, OpDeleting, IntentRemove,
		func(_ context.Context, control LifecycleControl) error { return control.StopService() }); err != nil {
		t.Fatalf("cleanup delete = %v", err)
	}
}

func TestReconcileChangedSpecRestartsExistingService(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	plugin := testServicePlugin(t, "changed", nil, "backend/new-missing", true)
	oldSpec := ServiceSpec{
		PluginID:        plugin.Name,
		Dir:             plugin.Dir,
		Command:         "backend/old",
		ProtocolVersion: 1,
		Enabled:         true,
	}

	seedSupervisorStateForTest(runtime.supervisor, plugin.Name, &oldSpec, &serviceRecord{
		spec:   oldSpec,
		status: RuntimeStatus{State: StateReady},
	}, &transition{intent: IntentRun, operation: OpNone})

	runtime.Reconcile(context.Background(), []*registry.Plugin{plugin})
	waitForLifecycleAttempt(t, runtime, plugin.Name)

	if got := runtime.Status(plugin.Name).State; got != StateBackoff {
		t.Fatalf("changed service state = %q, want restart attempt/backoff", got)
	}
}

func slowStartupRuntime(t *testing.T, pluginID string) (*RuntimeImpl, *registry.Plugin) {
	t.Helper()

	root := t.TempDir()
	pluginDir := filepath.Join(root, "plugin")
	commandPath := filepath.Join(pluginDir, "backend", "stall.sh")

	if err := os.MkdirAll(filepath.Dir(commandPath), 0o700); err != nil {
		t.Fatalf("create command directory: %v", err)
	}

	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\nsleep 10\n"), 0o700); err != nil {
		t.Fatalf("write service command: %v", err)
	}

	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Supervisor: SupervisorConfig{
			ReadinessTimeout: 10 * time.Second,
			StopTimeout:      500 * time.Millisecond,
			FinalReapTimeout: 500 * time.Millisecond,
		},
	})
	plugin := testServicePlugin(t, pluginID, nil, "backend/stall.sh", true)
	plugin.Dir = pluginDir

	return runtime, plugin
}

func waitForLifecycleAttempt(t *testing.T, runtime *RuntimeImpl, pluginID string) {
	t.Helper()

	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(time.Millisecond)

	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			t.Fatalf("startup did not finish: op=%v state=%q", runtime.operationOf(pluginID), runtime.Status(pluginID).State)
		case <-ticker.C:
			if runtime.operationOf(pluginID) == OpNone && runtime.Status(pluginID).State == StateBackoff {
				return
			}
		}
	}
}
