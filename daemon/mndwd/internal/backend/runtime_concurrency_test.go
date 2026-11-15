package backend

import (
	"context"
	"os"
	"path/filepath"
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
	promotedDone := make(chan struct{})
	queuedStartPlan := make(chan startPlan, 1)
	runtime.supervisor.startDesired = func(spec ServiceSpec) {
		if spec.PluginID == "service-c" {
			close(firstStartupEntered)
			<-releaseFirstStartup

			return
		}

		queuedStartPlan <- runtime.supervisor.planStart(spec, RuntimePaths{})
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

	close(releaseFirstStartup)

	select {
	case <-promotedDone:
	case <-time.After(time.Second):
		t.Fatal("queued promoted startup did not run after first startup was released")
	}

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

	runtime.supervisor.withLock(func() {
		runtime.supervisor.coord.records[plugin.Name] = &transition{intent: IntentRun, operation: OpNone}
		runtime.supervisor.desired[plugin.Name] = oldSpec
		runtime.supervisor.services[plugin.Name] = &serviceRecord{
			spec:   oldSpec,
			status: RuntimeStatus{State: StateReady},
		}
	})

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
