package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"
	"unsafe"
)

type observedDoneContext struct {
	context.Context
	observed chan struct{}
	once     sync.Once
}

func TestStartupsIdleTracksCount(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))

	if unsafe.Sizeof(startupTicket{}) == 0 {
		t.Fatal("startupTicket must not be zero-sized because its pointer is an identity")
	}

	if unsafe.Sizeof(retryState{}) == 0 {
		t.Fatal("retryState must not be zero-sized because its pointer is an identity")
	}

	supervisor.mu.Lock()

	firstIdle := supervisor.startupsIdleLocked()

	select {
	case <-firstIdle:
	default:
		supervisor.mu.Unlock()
		t.Fatal("idle channel is open with no startups")
	}

	supervisor.addStartupLocked()

	active := supervisor.startupsIdleLocked()

	if count := supervisor.startups; count != 1 {
		supervisor.mu.Unlock()
		t.Fatalf("startup count after first add = %d, want 1", count)
	}

	supervisor.addStartupLocked()

	count := supervisor.startups
	idle := supervisor.startupsIdleLocked()

	if count != 2 || idle != active {
		supervisor.mu.Unlock()
		t.Fatalf("startup count/channel after second add = %d/%p, want 2/%p", count, idle, active)
	}

	supervisor.doneStartupLocked()

	select {
	case <-active:
		supervisor.mu.Unlock()
		t.Fatal("idle channel closed while one startup remained")
	default:
	}

	supervisor.doneStartupLocked()

	select {
	case <-active:
	default:
		supervisor.mu.Unlock()
		t.Fatal("idle channel remained open after the last startup finished")
	}

	supervisor.addStartupLocked()

	next := supervisor.startupsIdleLocked()

	if next == active {
		supervisor.mu.Unlock()
		t.Fatal("new startup reused the closed idle channel")
	}

	supervisor.doneStartupLocked()
	supervisor.mu.Unlock()
}

func TestRetryCallbackAfterCancelDoesNothing(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	const pluginID = "retry"
	started := make(chan struct{}, 1)
	callbackWaiting := make(chan struct{}, 1)
	callbackDone := make(chan string, 1)
	supervisor.startDesired = func(ServiceSpec) {
		started <- struct{}{}
	}
	supervisor.retryCallbackStarting = func(string) {
		callbackWaiting <- struct{}{}
	}
	supervisor.retryCallbackDone = func(name string) {
		callbackDone <- name
	}

	spec := enabledSpec(pluginID)

	supervisor.mu.Lock()
	supervisor.setDesiredLocked(pluginID, &spec)

	record := supervisor.ensureServiceRecordLocked(pluginID)
	record.service.status.State = StateBackoff

	if !supervisor.acquireServiceSlotLocked(record) {
		supervisor.mu.Unlock()
		t.Fatal("failed to reserve retry service slot")
	}

	transition := supervisor.ensureTransitionRecordLocked(pluginID)
	transition.transition.intent = IntentRun

	supervisor.scheduleRetry(pluginID, time.Millisecond)

	select {
	case <-callbackWaiting:
	case <-time.After(time.Second):
		supervisor.mu.Unlock()
		t.Fatal("retry callback did not reach the mutex")
	}

	supervisor.stopRetryTimerLocked(pluginID)
	supervisor.mu.Unlock()

	select {
	case name := <-callbackDone:
		if name != pluginID {
			t.Fatalf("retry callback completion plugin = %q, want %q", name, pluginID)
		}
	case <-time.After(time.Second):
		t.Fatal("retry callback did not finish after cancellation")
	}

	waitStartupsIdleForTest(supervisor)

	select {
	case <-started:
		t.Fatal("canceled retry callback started the service")
	default:
	}
}

func (ctx *observedDoneContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.observed) })

	return ctx.Context.Done()
}

func TestReconcileSeedsEnabledStartupCandidate(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 4}))
	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("svc")})

	if !containsID(plan.startIDs, "svc") {
		t.Fatal("initial reconcile did not return enabled startup candidate")
	}
}

func TestReconcileDoesNotReserveServicesForCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))

	plan := supervisor.Reconcile(ctx, []ServiceSpec{enabledSpec("svc")})

	if len(plan.startIDs) != 0 {
		t.Fatalf("canceled reconcile start IDs = %#v, want none", plan.startIDs)
	}

	if got := supervisor.Status("svc").State; got != StateStopped {
		t.Fatalf("canceled reconcile state = %q, want stopped", got)
	}

	if got := supervisor.reservedServiceCount(); got != 0 {
		t.Fatalf("canceled reconcile reserved %d service slots, want 0", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
}

func TestRetryTimerStopsWhenLifetimeEnds(t *testing.T) {
	lifetime, cancelLifetime := context.WithCancel(context.Background())

	defer cancelLifetime()

	cfg := testSupervisorConfig(t)
	cfg.LifetimeCtx = lifetime
	supervisor := newSupervisor(cfg, NewAdmission(Limits{MaxSupervisedServices: 1}))
	retried := make(chan struct{}, 1)
	supervisor.startDesired = func(ServiceSpec) { retried <- struct{}{} }
	spec := enabledSpec("retry")

	seedSupervisorRetryForTest(supervisor, spec, 10*time.Millisecond)

	cancelLifetime()

	select {
	case <-retried:
		t.Fatal("retry started after daemon lifetime ended")
	case <-time.After(30 * time.Millisecond):
	}
}

func TestReconcileReservesBuiltinServicesBeforeUserServices(t *testing.T) {
	cfg := testSupervisorConfig(t)
	cfg.Limits.MaxSupervisedServices = 3
	supervisor := newSupervisor(cfg, NewAdmission(Limits{MaxSupervisedServices: 3}))
	specs := []ServiceSpec{
		{PluginID: "user-c", ProtocolVersion: 1, Enabled: true},
		{PluginID: "builtin-z", ProtocolVersion: 1, Builtin: true, Enabled: true},
		{PluginID: "user-a", ProtocolVersion: 1, Enabled: true},
		{PluginID: "builtin-a", ProtocolVersion: 1, Builtin: true, Enabled: true},
		{PluginID: "user-b", ProtocolVersion: 1, Enabled: true},
	}

	plan := supervisor.Reconcile(context.Background(), specs)

	wantStarts := []string{"builtin-a", "builtin-z", "user-a"}

	if !reflect.DeepEqual(plan.startIDs, wantStarts) {
		t.Fatalf("start IDs = %#v, want %#v", plan.startIDs, wantStarts)
	}

	for _, pluginID := range []string{"user-b", "user-c"} {
		if got := supervisor.Status(pluginID).State; got != StateCapacityBlocked {
			t.Errorf("%s state = %q, want %q", pluginID, got, StateCapacityBlocked)
		}
	}

	if got := supervisor.reservedServiceCount(); got != 3 {
		t.Fatalf("reserved service slots = %d, want 3", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
}

func TestReconcileReleasesReservedSlotWhenStartupIsSupersededOrRemoved(t *testing.T) {
	tests := []struct {
		name       string
		superseded bool
	}{
		{name: "disabled before launch", superseded: true},
		{name: "removed before launch"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))

			supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("svc")})

			if got := supervisor.reservedServiceCount(); got != 1 {
				t.Fatalf("reserved service slots before superseding = %d, want 1", got)
			}

			if testCase.superseded {
				disabled := enabledSpec("svc")
				disabled.Enabled = false
				plan := supervisor.Reconcile(context.Background(), []ServiceSpec{disabled})

				if !containsID(plan.stopIDs, "svc") {
					t.Fatalf("superseded service was not planned for cleanup: %+v", plan)
				}
			} else {
				plan := supervisor.Reconcile(context.Background(), nil)

				if !containsID(plan.removeIDs, "svc") {
					t.Fatalf("removed service was not planned for cleanup: %+v", plan)
				}
			}

			if err := supervisor.stopRecord(context.Background(), "svc"); err != nil {
				t.Fatalf("execute planned cleanup: %v", err)
			}

			if outcome := supervisor.beginDesiredStartup(enabledSpec("svc")); !outcome.conflict {
				t.Fatal("superseded startup was still eligible after cleanup")
			}

			if got := supervisor.reservedServiceCount(); got != 0 {
				t.Fatalf("reserved service slots after superseding = %d, want 0", got)
			}

			assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
		})
	}
}

func TestClaimSlotKeepsNoSlot(t *testing.T) {
	tests := []struct {
		name string
		from slotState
		want slotState
	}{
		{name: "none stays none", from: slotNone, want: slotNone},
		{name: "reservation becomes held", from: slotReservedByReconcile, want: slotHeld},
		{name: "held stays held", from: slotHeld, want: slotHeld},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &serviceState{slot: test.from}

			service.claimSlot()

			if service.slot != test.want {
				t.Errorf("slot after claimSlot = %s, want %s", service.slot, test.want)
			}
		})
	}
}

func TestServiceSpecEqual(t *testing.T) {
	base := ServiceSpec{
		PluginID:         "svc",
		Dir:              "/plugins/svc",
		Command:          "run.sh",
		Args:             []string{"--serve"},
		ProtocolVersion:  1,
		RCISessionSocket: "/run/rci.sock",
		Builtin:          true,
		Enabled:          true,
		RemovalPending:   true,
	}

	tests := []struct {
		name  string
		left  ServiceSpec
		other ServiceSpec
		want  bool
	}{
		{name: "identical", left: base, other: base, want: true},
		{name: "nil and empty args", left: ServiceSpec{PluginID: base.PluginID, Dir: base.Dir, Command: base.Command, ProtocolVersion: base.ProtocolVersion, RCISessionSocket: base.RCISessionSocket, Builtin: base.Builtin, Enabled: base.Enabled, RemovalPending: base.RemovalPending}, other: ServiceSpec{PluginID: base.PluginID, Dir: base.Dir, Command: base.Command, ProtocolVersion: base.ProtocolVersion, RCISessionSocket: base.RCISessionSocket, Builtin: base.Builtin, Enabled: base.Enabled, RemovalPending: base.RemovalPending, Args: []string{}}, want: true},
		{name: "different args order", left: base, other: ServiceSpec{PluginID: base.PluginID, Dir: base.Dir, Command: base.Command, Args: []string{"--other", "--serve"}, ProtocolVersion: base.ProtocolVersion, RCISessionSocket: base.RCISessionSocket, Builtin: base.Builtin, Enabled: base.Enabled, RemovalPending: base.RemovalPending}, want: false},
		{name: "different args length", left: base, other: ServiceSpec{PluginID: base.PluginID, Dir: base.Dir, Command: base.Command, Args: []string{"--serve", "--other"}, ProtocolVersion: base.ProtocolVersion, RCISessionSocket: base.RCISessionSocket, Builtin: base.Builtin, Enabled: base.Enabled, RemovalPending: base.RemovalPending}, want: false},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := testCase.left.Equal(testCase.other); got != testCase.want {
				t.Fatalf("Equal() = %t, want %t", got, testCase.want)
			}
		})
	}
}

func TestServiceSpecEqualCoversEveryField(t *testing.T) {
	typeOfSpec := reflect.TypeOf(ServiceSpec{})
	zero := ServiceSpec{}

	for index := 0; index < typeOfSpec.NumField(); index++ {
		field := typeOfSpec.Field(index)
		changed := reflect.New(typeOfSpec).Elem()
		value := changed.Field(index)

		switch value.Kind() {
		case reflect.String:
			value.SetString("x")
		case reflect.Int:
			value.SetInt(1)
		case reflect.Bool:
			value.SetBool(true)
		case reflect.Slice:
			value.Set(reflect.ValueOf([]string{"x"}))
		default:
			t.Fatalf("ServiceSpec.%s: unsupported kind %s; extend Equal and this test", field.Name, value.Kind())
		}

		if zero.Equal(changed.Interface().(ServiceSpec)) {
			t.Errorf("Equal() returned true after changing ServiceSpec.%s", field.Name)
		}
	}
}

func TestReconcileSkipsRemoveIntent(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 4}))

	supervisor.beginLifecycle("svc", OpDeleting, IntentRemove)

	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("svc")})

	if len(plan.startIDs) != 0 || len(plan.stopIDs) != 0 {
		t.Fatalf("reconcile planned work under remove intent: %+v", plan)
	}
}

func TestReconcileSeedsDurableRemovalMarker(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 4}))
	spec := enabledSpec("svc")
	spec.RemovalPending = true
	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{spec})

	if len(plan.startIDs) != 0 {
		t.Fatalf("reconcile planned startup with durable removal pending: %+v", plan)
	}

	if got := supervisor.intentOf("svc"); got != IntentRemove {
		t.Fatalf("removal-pending intent = %v, want IntentRemove", got)
	}
}

func TestStaleStartupCannotPublishFailureOrReadiness(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 4}))
	start := supervisor.beginLifecycle("svc", OpStarting, IntentRun)
	record := setSupervisorServiceRecordForTest(supervisor, "svc", &serviceRecord{status: RuntimeStatus{State: StateStarting}})

	supervisor.beginLifecycle("svc", OpDeleting, IntentRemove)
	supervisor.failStart(start.run, "svc", errors.New("late failure"))
	supervisor.markServiceReady(start.run, record)

	if got := supervisor.Status("svc").State; got != StateStarting {
		t.Fatalf("stale startup changed service state to %q", got)
	}
}

func testSupervisorConfig(t *testing.T) SupervisorConfig {
	t.Helper()

	return (SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		SupportedProtocols: []int{1},
		Limits:             Limits{MaxSupervisedServices: 4},
		Logger:             backendTestLogger(),
	}).withDefaults()
}

func enabledSpec(pluginID string) ServiceSpec {
	return ServiceSpec{PluginID: pluginID, ProtocolVersion: 1, Enabled: true}
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}

	return false
}

func TestSupervisorConfigAppliesDefaults(t *testing.T) {
	now := func() time.Time { return time.Unix(123, 0) }
	cfg := (SupervisorConfig{Now: now}).withDefaults()

	if cfg.Logger == nil {
		t.Fatal("Logger = nil, want discard logger")
	}

	if cfg.Limits.MaxSupervisedServices != 8 {
		t.Fatalf("MaxSupervisedServices = %d, want 8", cfg.Limits.MaxSupervisedServices)
	}

	if cfg.ReadinessTimeout != DefaultServiceHTTPTimeout || cfg.StopTimeout != DefaultStandaloneStopTimeout ||
		cfg.DiagnosticsTimeout != 2*time.Second || cfg.FinalReapTimeout != DefaultFinalReapTimeout {
		t.Fatalf("timeouts = %#v", cfg)
	}

	if cfg.Now == nil || cfg.Now() != now() {
		t.Fatal("injected Now was not preserved")
	}
}

func TestSupervisorStartsWithStoppedStatusAndReportsCapacity(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{RuntimeRoot: t.TempDir(), Limits: Limits{MaxSupervisedServices: 1}, SupportedProtocols: []int{1}})

	if got := supervisor.Status("missing").State; got != StateStopped {
		t.Fatalf("missing state = %q", got)
	}

	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("first"), enabledSpec("second")})

	if !reflect.DeepEqual(plan.startIDs, []string{"first"}) {
		t.Fatalf("start IDs = %#v, want [first]", plan.startIDs)
	}

	if got := supervisor.Status("second").State; got != StateCapacityBlocked {
		t.Fatalf("second state = %q, want %q", got, StateCapacityBlocked)
	}

	if got := supervisor.reservedServiceCount(); got != 1 {
		t.Fatalf("reserved service slots = %d, want 1", got)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
}

func TestSupervisorDevValidationAllowsSymlinkedBuiltinRoot(t *testing.T) {
	sourceDir := t.TempDir()
	pluginRoot := t.TempDir()
	commandDir := filepath.Join(sourceDir, "backend")
	command := filepath.Join(commandDir, "server")

	if err := os.Mkdir(commandDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(command, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	symlinkedPlugin := filepath.Join(pluginRoot, "sample")

	if err := os.Symlink(sourceDir, symlinkedPlugin); err != nil {
		t.Fatal(err)
	}

	strictRoot := t.TempDir()
	strictPaths, err := NewRuntimePaths(strictRoot, "sample")
	if err != nil {
		t.Fatal(err)
	}

	strict := NewSupervisor(SupervisorConfig{RuntimeRoot: strictRoot})
	_, err = strict.prepareStart(strictPaths, ServiceSpec{Dir: symlinkedPlugin, Command: "backend/server"})
	if err == nil {
		t.Fatal("strict service validation accepted a symlinked plugin root")
	}

	devRoot := t.TempDir()
	devPaths, err := NewRuntimePaths(devRoot, "sample")
	if err != nil {
		t.Fatal(err)
	}

	dev := NewSupervisor(SupervisorConfig{RuntimeRoot: devRoot, AllowSymlinkedBuiltinRoot: true})

	if _, err := dev.prepareStart(devPaths, ServiceSpec{
		Dir:     symlinkedPlugin,
		Command: "backend/server",
		Builtin: true,
	}); err != nil {
		t.Fatalf("dev service validation rejected a symlinked builtin root: %v", err)
	}
}

func TestSupervisorStartReturnsBareServiceCapacitySentinel(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		Limits:             Limits{MaxSupervisedServices: 1},
		SupportedProtocols: []int{1},
	})

	supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("occupied")})

	err := startSupervisorForTest(supervisor, ServiceSpec{
		PluginID:        "blocked",
		Dir:             t.TempDir(),
		Command:         "backend/server",
		ProtocolVersion: 1,
		Enabled:         true,
	})

	if err != ErrServiceCapacityExceeded {
		t.Fatalf("capacity error = %v, want bare ErrServiceCapacityExceeded", err)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
}

func TestSupervisorRecordsIncompatibleServiceWithoutStartingIt(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		SupportedProtocols: []int{1},
	})
	err := startSupervisorForTest(supervisor, ServiceSpec{
		PluginID:        "incompatible",
		Dir:             t.TempDir(),
		Command:         "backend/server",
		ProtocolVersion: 2,
		Enabled:         true,
	})
	if err == nil {
		t.Fatal("incompatible service start succeeded")
	}

	status := supervisor.Status("incompatible")

	if status.State != StateStopped {
		t.Fatalf("incompatible service state = %q, want stopped", status.State)
	}

	if status.RequiredProtocol != 2 || status.Compatible == nil || *status.Compatible {
		t.Fatalf("incompatible service status = %+v", status)
	}

	if len(status.SupportedProtocols) != 1 || status.SupportedProtocols[0] != 1 {
		t.Fatalf("supported protocols = %#v, want [1]", status.SupportedProtocols)
	}
}

func TestSupervisorStartFailureRecordsBackoffBeforeForgetStopsService(t *testing.T) {
	supervisor := NewSupervisor(SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		SupportedProtocols: []int{1},
	})

	err := startSupervisorForTest(supervisor, ServiceSpec{
		PluginID:        "invalid-command",
		Dir:             t.TempDir(),
		Command:         "backend/missing.sh",
		ProtocolVersion: 1,
		Enabled:         true,
	})

	if err == nil {
		t.Fatal("start with missing command succeeded")
	}

	status := supervisor.Status("invalid-command")

	if status.State != StateBackoff || status.ConsecutiveFailures != 1 || status.LastExit != "start failed" || status.LastError == "" || status.NextAttemptAt == nil {
		t.Fatalf("failed start status = %+v", status)
	}

	if err := stopSupervisorForTest(supervisor, "invalid-command"); err != nil {
		t.Fatalf("Forget failed service: %v", err)
	}

	if status := supervisor.Status("invalid-command"); status.State != StateStopped {
		t.Fatalf("status after Forget = %q, want stopped", status.State)
	}
}

func startSupervisorForTest(supervisor *Supervisor, spec ServiceSpec) error {
	outcome := supervisor.beginLifecycle(spec.PluginID, OpStarting, IntentRun)
	err := supervisor.startService(outcome.run, spec)

	close(outcome.run.workDone)

	token := &lifecycleToken{run: outcome.run}

	if err == nil {
		supervisor.finishLifecycle(token, OpStarting)
	} else {
		supervisor.failLifecycle(token, err)
	}

	return err
}

func stopSupervisorForTest(supervisor *Supervisor, pluginID string) error {
	outcome := supervisor.beginLifecycle(pluginID, OpDeleting, IntentRemove)
	err := supervisor.stopService(outcome.run)

	close(outcome.run.workDone)

	token := &lifecycleToken{run: outcome.run}

	if err == nil {
		supervisor.finishLifecycle(token, OpDeleting)
	} else {
		supervisor.failLifecycle(token, err)
	}

	return err
}

func TestRecordFailureDelaysAndCutoff(t *testing.T) {
	base := time.Unix(2_000, 0)
	status := RuntimeStatus{State: StateStarting}

	for attempt, wantDelay := range []time.Duration{1, 2, 4, 8} {
		delay, retry := recordFailure(&status, base, "exited", errors.New("x"))

		if !retry {
			t.Fatalf("attempt %d retry = false, want true", attempt+1)
		}

		if delay != time.Duration(wantDelay)*time.Second {
			t.Fatalf("attempt %d delay = %s, want %ds", attempt+1, delay, wantDelay)
		}

		if status.State != StateBackoff {
			t.Fatalf("attempt %d state = %q, want backoff", attempt+1, status.State)
		}
	}

	delay, retry := recordFailure(&status, base, "exited", errors.New("x"))

	if retry || delay != 0 {
		t.Fatalf("fifth failure retry=%v delay=%s, want false + 0", retry, delay)
	}

	if status.State != StateFailed || status.NextAttemptAt != nil {
		t.Fatalf("fifth failure status = %+v", status)
	}
}

func TestTransitionFailureLockedBackoffProgression(t *testing.T) {
	base := time.Unix(1_000, 0)
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return base }, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	record := setSupervisorServiceRecordForTest(supervisor, "svc", &serviceRecord{status: RuntimeStatus{State: StateStarting}})

	wantDelays := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
	}

	for attempt, wantDelay := range wantDelays {
		supervisor.mu.Lock()
		supervisor.transitionFailureLocked(record, "svc", "exited", errors.New("boom"))
		supervisor.mu.Unlock()

		status := supervisor.Status("svc")

		if status.State != StateBackoff {
			t.Fatalf("attempt %d state = %q, want backoff", attempt+1, status.State)
		}

		if status.ConsecutiveFailures != attempt+1 {
			t.Fatalf("attempt %d failures = %d, want %d", attempt+1, status.ConsecutiveFailures, attempt+1)
		}

		if status.NextAttemptAt == nil {
			t.Fatalf("attempt %d NextAttemptAt = nil", attempt+1)
		}

		if got := status.NextAttemptAt.Sub(base); got != wantDelay {
			t.Fatalf("attempt %d delay = %s, want %s", attempt+1, got, wantDelay)
		}
	}

	// Fifth consecutive failure crosses the cutoff into StateFailed with no retry.
	supervisor.mu.Lock()
	supervisor.transitionFailureLocked(record, "svc", "exited", errors.New("boom"))
	supervisor.mu.Unlock()

	status := supervisor.Status("svc")

	if status.State != StateFailed {
		t.Fatalf("fifth failure state = %q, want failed", status.State)
	}

	if status.NextAttemptAt != nil {
		t.Fatalf("failed state NextAttemptAt = %v, want nil", status.NextAttemptAt)
	}
}

func TestTransitionFailureLockedRecordsExitAndError(t *testing.T) {
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	record := setSupervisorServiceRecordForTest(supervisor, "svc", &serviceRecord{status: RuntimeStatus{State: StateReady, ConsecutiveFailures: 0}})

	supervisor.mu.Lock()
	supervisor.transitionFailureLocked(record, "svc", "start failed", errors.New("no binary"))
	supervisor.mu.Unlock()

	status := supervisor.Status("svc")

	if status.LastExit != "start failed" {
		t.Fatalf("LastExit = %q", status.LastExit)
	}

	if status.LastError != "no binary" {
		t.Fatalf("LastError = %q", status.LastError)
	}
}

func TestPlanStartIncompatibleWithoutRuntimeIsNoop(t *testing.T) {
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	paths, err := NewRuntimePaths(t.TempDir(), "svc")
	if err != nil {
		t.Fatalf("paths: %v", err)
	}

	plan := supervisor.planStart(ServiceSpec{PluginID: "svc", ProtocolVersion: 2, Enabled: true}, paths)

	if plan.action != startNoop {
		t.Fatalf("action = %d, want startNoop", plan.action)
	}

	if plan.err == nil {
		t.Fatal("err = nil, want unsupported protocol")
	}

	status := supervisor.Status("svc")

	if status.RequiredProtocol != 2 || status.Compatible == nil || *status.Compatible {
		t.Fatalf("status = %+v", status)
	}
}

func TestPlanStartCapacityBlocked(t *testing.T) {
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 1}, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)

	supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("occupied")})

	paths, err := NewRuntimePaths(t.TempDir(), "svc")
	if err != nil {
		t.Fatalf("paths: %v", err)
	}

	plan := supervisor.planStart(ServiceSpec{PluginID: "svc", ProtocolVersion: 1, Enabled: true}, paths)

	if plan.action != startNoop || plan.err != ErrServiceCapacityExceeded {
		t.Fatalf("action=%d err=%v, want startNoop + ErrServiceCapacityExceeded", plan.action, plan.err)
	}

	if supervisor.Status("svc").State != StateCapacityBlocked {
		t.Fatalf("state = %q, want capacity_blocked", supervisor.Status("svc").State)
	}

	if reserved := supervisor.reservedServiceCount(); reserved != 1 {
		t.Fatalf("reserved service slots = %d, want occupied slot only", reserved)
	}

	assertSupervisorServiceSlotsInvariantForTest(t, supervisor)
}

func TestRecentStderrSurvivesExit(t *testing.T) {
	// Status retains redacted stderr after process exit.
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))

	t.Cleanup(func() {
		if err := supervisor.StopAll(context.Background()); err != nil {
			t.Errorf("stop supervisor: %v", err)
		}
	})

	done := newProcessExit()
	done.err = errors.New("service exited")

	close(done.done)

	stderr := NewStderrRing(1024, 8)
	_, _ = stderr.Write([]byte("startup token=super-secret failed\n"))

	setSupervisorServiceRecordForTest(supervisor, "svc", &serviceRecord{
		done:   done,
		stderr: stderr,
		status: RuntimeStatus{State: StateReady},
	})

	supervisor.observeExit("svc", done)

	status := supervisor.Status("svc")

	if status.State != StateBackoff {
		t.Fatalf("state after exit = %q, want %q", status.State, StateBackoff)
	}

	if !reflect.DeepEqual(status.RecentStderr, []string{"startup token=[redacted] failed"}) {
		t.Fatalf("recent stderr after exit = %#v, want retained redacted output", status.RecentStderr)
	}

}

func TestPlanStartProceedReservesAndMarksStarting(t *testing.T) {
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 2}, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 2}),
	)
	paths, err := NewRuntimePaths(t.TempDir(), "svc")
	if err != nil {
		t.Fatalf("paths: %v", err)
	}

	plan := supervisor.planStart(ServiceSpec{PluginID: "svc", ProtocolVersion: 1, Enabled: true}, paths)

	if plan.action != startProceed || plan.err != nil {
		t.Fatalf("action=%d err=%v, want startProceed + nil", plan.action, plan.err)
	}

	if supervisor.Status("svc").State != StateStarting {
		t.Fatalf("state = %q, want starting", supervisor.Status("svc").State)
	}
}

func TestPlanStartBackoffNotElapsedIsNoop(t *testing.T) {
	now := time.Unix(1_000, 0)
	supervisor := newSupervisor(
		(SupervisorConfig{Now: func() time.Time { return now }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 1}, Logger: backendTestLogger()}).withDefaults(),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	future := now.Add(5 * time.Second)

	setSupervisorServiceRecordForTest(supervisor, "svc", &serviceRecord{status: RuntimeStatus{State: StateBackoff, NextAttemptAt: &future}})

	paths, err := NewRuntimePaths(t.TempDir(), "svc")
	if err != nil {
		t.Fatalf("paths: %v", err)
	}

	plan := supervisor.planStart(ServiceSpec{PluginID: "svc", ProtocolVersion: 1, Enabled: true}, paths)

	if plan.action != startNoop || plan.err == nil {
		t.Fatalf("action=%d err=%v, want startNoop + backoff error", plan.action, plan.err)
	}
}

func TestStopWaiterReadsItsOwnStopResult(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	stopA := &stopState{done: make(chan struct{})}
	record := setSupervisorServiceRecordForTest(supervisor, "demo", &serviceRecord{stop: stopA})

	waitCtx := &observedDoneContext{Context: context.Background(), observed: make(chan struct{})}
	waitResult := make(chan error, 1)

	go func() {
		waitResult <- supervisor.stopProcess(waitCtx, "demo", stopKeep)
	}()

	// Done signals after stopProcess captured stopA and reached the joiner select.
	select {
	case <-waitCtx.observed:
	case <-time.After(time.Second):
		t.Fatal("stop waiter did not reach its wait")
	}

	errA := errors.New("first stop error")
	errB := errors.New("second stop error")

	// Keep a reread of service.lastStopErr blocked until stop B has replaced stop A's summary.
	supervisor.mu.Lock()

	stopA.err = errA
	record.service.stop = nil
	record.service.lastStopErr = errA

	close(stopA.done)

	stopB := &stopState{done: make(chan struct{})}
	record.service.stop = stopB
	stopB.err = errB
	record.service.stop = nil
	record.service.lastStopErr = errB

	close(stopB.done)
	supervisor.unlock()

	select {
	case got := <-waitResult:
		if got != errA {
			t.Fatalf("stop waiter error = %v, want its own result %v", got, errA)
		}
	case <-time.After(time.Second):
		t.Fatal("stop waiter did not return")
	}
}

func TestStopFinishedPrefersDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	done := make(chan struct{})

	close(done)

	for attempt := 0; attempt < 100; attempt++ {
		if !stopFinished(ctx, done) {
			t.Fatalf("stopFinished returned false with done and context both ready on attempt %d", attempt+1)
		}
	}
}

func TestStopAllWaiterReadsItsOwnStopResult(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	stopA := &stopState{done: make(chan struct{})}
	record := setSupervisorServiceRecordForTest(supervisor, "demo", &serviceRecord{stop: stopA})
	errA := errors.New("first stop error")
	errB := errors.New("second stop error")
	results := []stopOperationResult{{stop: stopA, record: record}}

	supervisor.mu.Lock()

	stopA.err = errA
	record.service.stop = nil
	record.service.lastStopErr = errA

	close(stopA.done)

	stopB := &stopState{done: make(chan struct{})}
	record.service.stop = stopB
	stopB.err = errB
	record.service.stop = nil
	record.service.lastStopErr = errB

	close(stopB.done)
	supervisor.unlock()

	supervisor.waitForStopFinalizers(context.Background(), results)

	if results[0].err != errA {
		t.Fatalf("StopAll waiter error = %v, want its own result %v", results[0].err, errA)
	}
}

// A pending start recorded by an operation's own planning stays parked while that operation is current, even after
// the blocker that parked it is gone. Ending the operation is the only wake-up left.
func TestPendingStartResumesAfterOperationEnds(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	spec := enabledSpec("op-ends")
	started := make(chan ServiceSpec, 1)
	supervisor.startDesired = func(startSpec ServiceSpec) { started <- startSpec }

	seedSupervisorStateForTest(supervisor, spec.PluginID, &spec, &serviceRecord{
		spec: spec,
		// Backoff only keeps the I14 fixture count of the suite unchanged; the path under test never branches on it.
		status:      RuntimeStatus{State: StateBackoff},
		serviceHeld: true,
		done:        newProcessExit(),
		stop:        &stopState{done: make(chan struct{})},
	}, &transition{intent: IntentRun})

	operation := supervisor.beginLifecycleOperation(spec.PluginID, OpStarting, IntentRun)

	if err := supervisor.startDesiredService(operation.token, spec); err != nil {
		t.Fatalf("start during deferred stop = %v, want nil", err)
	}

	supervisor.mu.Lock()

	record := supervisor.serviceRecordLocked(spec.PluginID)
	record.service.proc = nil
	record.service.stop = nil

	supervisor.unlock()

	supervisor.settleAndAdmitForTest(spec.PluginID)
	waitStartupsIdleForTest(supervisor)

	select {
	case got := <-started:
		t.Fatalf("pending start launched while its operation was current: %+v", got)
	default:
	}

	supervisor.mu.Lock()

	effects := supervisor.commitLocked(operation.token.run)

	supervisor.unlock()
	supervisor.runEffects(effects)

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("resumed spec = %+v, want %+v", got, spec)
		}
	case <-time.After(time.Second):
		t.Fatal("pending start was lost when its operation ended")
	}

	waitStartupsIdleForTest(supervisor)
}

func TestPendingStartKeepsItsOwnArgs(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	spec := enabledSpec("own-args")
	spec.Args = []string{"--old"}
	record := setSupervisorServiceRecordForTest(supervisor, spec.PluginID, &serviceRecord{spec: spec})

	supervisor.mu.Lock()

	supervisor.markPendingStartLocked(record, spec, false)

	spec.Args[0] = "--new"
	got := record.service.pending.spec.Args[0]

	supervisor.unlock()

	if got != "--old" {
		t.Fatalf("pending start Args[0] after the caller changed its spec = %q, want %q", got, "--old")
	}
}

// Guard for a state that is unreachable today: operation exclusivity keeps a stop and a launch apart. TASK-48 lets a
// stop be requested during a launch, and from then on beginServiceLaunch itself must refuse while a stop is in progress.
func TestBeginServiceLaunchRefusesWhileStopping(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 1}))
	spec := enabledSpec("launch-while-stopping")

	seedSupervisorStateForTest(supervisor, spec.PluginID, &spec, &serviceRecord{
		spec:        spec,
		status:      RuntimeStatus{State: StateStopped},
		serviceHeld: true,
		stop:        &stopState{done: make(chan struct{})},
	}, &transition{intent: IntentRun})

	operation := supervisor.beginLifecycleOperation(spec.PluginID, OpStarting, IntentRun)
	record := supervisorServiceForTest(supervisor, spec.PluginID)

	if launch, admitted := supervisor.beginServiceLaunch(operation.token.run, record); admitted || launch != nil {
		t.Fatalf("beginServiceLaunch during a stop = (%v, %t), want (nil, false)", launch, admitted)
	}

	supervisor.mu.Lock()

	defer supervisor.unlock()

	if record.service.proc != nil {
		t.Fatalf("process phase after the refused launch = %T, want none", record.service.proc)
	}
}

func receiveStartedForTest(t *testing.T, started <-chan string, want string) {
	t.Helper()

	select {
	case got := <-started:
		if got != want {
			t.Fatalf("started plugin = %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("plugin %q was not started", want)
	}
}

// receiveStartedSetForTest waits for exactly the wanted startups in any order: one tail can return several startup
// effects, and startupEffect.run starts each in its own goroutine.
func receiveStartedSetForTest(t *testing.T, started <-chan string, want ...string) {
	t.Helper()

	remaining := slices.Clone(want)

	for len(remaining) > 0 {
		select {
		case got := <-started:
			index := slices.Index(remaining, got)

			if index < 0 {
				t.Fatalf("started plugin = %q, want one of %q", got, remaining)
			}

			remaining = slices.Delete(remaining, index, index+1)
		case <-time.After(time.Second):
			t.Fatalf("plugins %q were not started", remaining)
		}
	}
}

func requireNothingStartedForTest(t *testing.T, supervisor *Supervisor, started <-chan string) {
	t.Helper()

	waitStartupsIdleForTest(supervisor)

	select {
	case got := <-started:
		t.Fatalf("unexpected startup of %q", got)
	default:
	}
}

// newAdmissionSupervisorForTest returns a one-slot supervisor whose startup effects are reported on the channel.
func newAdmissionSupervisorForTest(t *testing.T) (*Supervisor, <-chan string) {
	t.Helper()

	cfg := testSupervisorConfig(t)
	cfg.Limits.MaxSupervisedServices = 1
	supervisor := newSupervisor(cfg, NewAdmission(cfg.Limits))
	started := make(chan string, 4)
	supervisor.startDesired = func(spec ServiceSpec) { started <- spec.PluginID }

	return supervisor, started
}

// The slot of the plugin is free while another plugin's operation runs; when that operation ends the plugin is
// admitted in the same critical section, with no other event to wake it.
func TestBlockedPluginIsAdmittedWhenItsOperationEnds(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	holder := enabledSpec("alpha")
	waiter := enabledSpec("beta")

	supervisor.Reconcile(context.Background(), []ServiceSpec{holder})
	supervisor.Reconcile(context.Background(), []ServiceSpec{holder, waiter})

	operation := supervisor.beginLifecycleOperation(waiter.PluginID, OpStarting, IntentRun)

	if err := supervisor.stopRecord(context.Background(), holder.PluginID); err != nil {
		t.Fatalf("release the holder's slot: %v", err)
	}

	requireNothingStartedForTest(t, supervisor, started)

	supervisor.finishLifecycle(operation.token, OpStarting)

	receiveStartedForTest(t, started, waiter.PluginID)

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter did not get the free slot when its operation ended")
	}
}

// Guard for a state that is unreachable while I13 is enforced: a free slot with an admissible plugin still blocked.
// It pins the queue order of requestSlotLocked: a plugin that starts without waiting does not take a slot ahead of an
// earlier waiter.
func TestSlotRequestQueuesBehindEarlierWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	requester := enabledSpec("beta")

	seedSupervisorStateForTest(supervisor, waiter.PluginID, &waiter, &serviceRecord{
		spec:   waiter,
		status: RuntimeStatus{State: StateCapacityBlocked},
	}, &transition{intent: IntentRun})

	plan := supervisor.planStart(requester, RuntimePaths{})

	if plan.action != startNoop || !errors.Is(plan.err, ErrServiceCapacityExceeded) {
		t.Fatalf("plan for the late requester = (%d, %v), want (%d, %v)", plan.action, plan.err, startNoop, ErrServiceCapacityExceeded)
	}

	receiveStartedForTest(t, started, waiter.PluginID)

	if got := supervisor.Status(requester.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("requester state = %q, want %q", got, StateCapacityBlocked)
	}
}

// A startup that admission allowed is still refused when StopAll closed admission before the effect ran; its
// accounting is settled, so StopAll returns, and nothing launches after it.
func TestStopAllAfterAdmissionBeforeStartupRuns(t *testing.T) {
	cfg := testSupervisorConfig(t)
	cfg.Limits.MaxSupervisedServices = 1
	supervisor := newSupervisor(cfg, NewAdmission(cfg.Limits))
	entered := make(chan struct{})
	release := make(chan struct{})
	launched := make(chan bool, 1)
	supervisor.startDesired = func(spec ServiceSpec) {
		close(entered)

		<-release

		launched <- !supervisor.beginDesiredStartup(spec).conflict
	}

	holder := enabledSpec("alpha")
	waiter := enabledSpec("beta")

	supervisor.Reconcile(context.Background(), []ServiceSpec{holder})
	supervisor.Reconcile(context.Background(), []ServiceSpec{holder, waiter})

	if err := supervisor.stopRecord(context.Background(), holder.PluginID); err != nil {
		t.Fatalf("release the holder's slot: %v", err)
	}

	<-entered

	stopped := make(chan error, 1)

	go func() { stopped <- supervisor.StopAll(context.Background()) }()

	for deadline := time.Now().Add(time.Second); ; runtime.Gosched() {
		supervisor.mu.Lock()

		shuttingDown := supervisor.shuttingDown

		supervisor.unlock()

		if shuttingDown {
			break
		}

		if time.Now().After(deadline) {
			t.Fatal("StopAll did not close admission")
		}
	}

	select {
	case err := <-stopped:
		t.Fatalf("StopAll = %v before the accounted startup finished", err)
	default:
	}

	close(release)

	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("StopAll = %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("StopAll did not return after the held startup finished")
	}

	if <-launched {
		t.Fatal("startup launched after StopAll closed admission")
	}
}

// Past the retry cutoff a plugin stays failed: a start request that waited behind its running process (same spec, not
// a retry) is dropped when the crash reaches StateFailed, instead of relaunching the plugin at once. The failed plugin
// gives its slot to the earlier waiter.
func TestCrashPastRetryCutoffDropsSameSpecPendingStart(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	spec := enabledSpec("beta")
	waiter := enabledSpec("alpha")
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, spec, RuntimeStatus{State: StateReady, ConsecutiveFailures: maxConsecutiveFailures - 1}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, spec})
	supervisor.launchDesiredStartup(spec)

	if !supervisor.pluginSnapshot(spec.PluginID).pendingStart {
		t.Fatal("startup beside the running process did not leave a pending start")
	}

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(spec.PluginID, done)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	snapshot := supervisor.pluginSnapshot(spec.PluginID)

	if snapshot.status.State != StateFailed || snapshot.pendingStart {
		t.Fatalf("after the cutoff crash state = %q, pending start = %t, want %q and none", snapshot.status.State, snapshot.pendingStart, StateFailed)
	}
}

// A changed spec that is pending while a start run is in flight survives the crash that reaches StateFailed: it
// settles when the run ends. The child is seeded as started-but-unregistered because production reaches that phase
// only inside startService, between attachStartedProcess and registerServiceProcess; the run is begun directly.
func TestCrashPastRetryCutoffKeepsChangedSpecPendingStart(t *testing.T) {
	supervisor, _ := newAdmissionSupervisorForTest(t)
	started := make(chan ServiceSpec, 2)
	supervisor.startDesired = func(spec ServiceSpec) { started <- spec }
	first := enabledSpec("beta")
	changed := first
	changed.Args = []string{"--changed"}
	done := newProcessExit()

	seedSupervisorStateForTest(supervisor, first.PluginID, &first, &serviceRecord{
		spec:        first,
		status:      RuntimeStatus{State: StateStarting, ConsecutiveFailures: maxConsecutiveFailures - 1},
		serviceHeld: true,
		done:        done,
	}, &transition{intent: IntentRun})

	supervisor.mu.Lock()

	service := supervisor.serviceRecordLocked(first.PluginID).service
	service.proc = procStarted{process: service.process()}

	supervisor.unlock()

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{changed}); !containsID(plan.startIDs, first.PluginID) {
		t.Fatalf("start IDs = %#v, want %q", plan.startIDs, first.PluginID)
	}

	operation := supervisor.beginLifecycleOperation(first.PluginID, OpStarting, IntentRun)

	if plan := supervisor.planStart(changed, RuntimePaths{}); plan.action != startNoop || plan.err != nil {
		t.Fatalf("plan beside the unregistered child = (%d, %v), want (%d, nil)", plan.action, plan.err, startNoop)
	}

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(first.PluginID, done)

	snapshot := supervisor.pluginSnapshot(first.PluginID)

	if snapshot.status.State != StateFailed || !snapshot.pendingStart {
		t.Fatalf("after the cutoff crash state = %q, pending start = %t, want %q and a pending start", snapshot.status.State, snapshot.pendingStart, StateFailed)
	}

	supervisor.finishLifecycle(operation.token, OpStarting)

	select {
	case got := <-started:
		if !got.Equal(changed) {
			t.Fatalf("started spec = %+v, want %+v", got, changed)
		}
	case <-time.After(time.Second):
		t.Fatal("changed spec was dropped by the cutoff crash")
	}
}

// A crash with a changed desired spec restarts the plugin and it keeps its slot: a waiter that sorts earlier does not
// get the slot the plugin released and asked for again in the same step.
func TestExitedPluginWithChangedSpecKeepsItsSlotFromEarlierWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")
	changed := own
	changed.Args = []string{"--changed"}
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, changed})

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(own.PluginID, done)

	receiveStartedForTest(t, started, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state after the restart = %q, want %q", got, StateCapacityBlocked)
	}
}

// Guard for a state that is unreachable today: StopAll clears every desired spec, so nothing is admissible once
// shutdown starts. It pins that admission itself is closed, not only the startup effect it would issue.
func TestAdmitDoesNothingAfterShutdownStarts(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")

	seedSupervisorStateForTest(supervisor, waiter.PluginID, &waiter, &serviceRecord{
		spec:   waiter,
		status: RuntimeStatus{State: StateCapacityBlocked},
	}, &transition{intent: IntentRun})

	supervisor.mu.Lock()

	supervisor.shuttingDown = true

	supervisor.unlock()

	supervisor.admitBlockedForTest()
	requireNothingStartedForTest(t, supervisor, started)

	if supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("admission handed a slot out after shutdown started")
	}
}

// A plugin in backoff keeps its slot, then gets a changed spec and starts through the lifecycle: planStartLocked
// releases the slot and asks for it again in the same step, and a waiter that sorts earlier does not get it.
func TestPlanStartWithChangedSpecKeepsItsSlotFromEarlierWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")
	changed := own
	changed.Args = []string{"--changed"}
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(own.PluginID, done)

	if got := supervisor.Status(own.PluginID).State; got != StateBackoff {
		t.Fatalf("state after the crash = %q, want %q", got, StateBackoff)
	}

	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, changed})

	if !containsID(plan.startIDs, own.PluginID) {
		t.Fatalf("start IDs = %#v, want %q", plan.startIDs, own.PluginID)
	}

	supervisor.beginLifecycleOperation(own.PluginID, OpStarting, IntentRun)

	if got := supervisor.planStart(changed, RuntimePaths{}); got.action != startProceed || got.err != nil {
		t.Fatalf("plan for the changed spec = (%d, %v), want (%d, nil)", got.action, got.err, startProceed)
	}

	requireNothingStartedForTest(t, supervisor, started)

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}
}

// releaseStopWithPendingStartForTest finishes a release stop of own while own has a pending start for a changed spec
// and waiter is capacity-blocked. Production reaches this state when a lifecycle start arrives during a release stop
// that outlives its run (a timed-out disable): planStartLocked marks the pending start for the same spec, and for a
// changed spec startReplace joins the stop and the join takes the stronger kind. The helper writes the stop and
// calls Reconcile and launchDesiredStartup by hand instead, because Reconcile never lists a plugin that has a stop
// in startIDs (prepareReservationLocked refuses while stop != nil).
func releaseStopWithPendingStartForTest(t *testing.T, supervisor *Supervisor, waiter, own ServiceSpec) {
	t.Helper()

	changed := own
	changed.Args = []string{"--changed"}

	supervisor.Reconcile(context.Background(), []ServiceSpec{own})
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	paths := RuntimePaths{}
	stop := &stopState{done: make(chan struct{}), kind: stopRelease}

	supervisor.mu.Lock()

	record := supervisor.serviceRecordLocked(own.PluginID)
	record.service.stop = stop

	supervisor.unlock()

	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, changed})
	supervisor.launchDesiredStartup(changed)

	if !supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("startup during the stop did not leave a pending start")
	}

	if err := supervisor.finishStop(own.PluginID, record, nil, paths, stop, nil); err != nil {
		t.Fatalf("finishStop = %v, want nil", err)
	}
}

// A stop that releases the slot finished while its plugin, disabled and enabled again with a changed spec, has a pending
// start. The plugin gave its slot up, so its start asks the queue like any other and waits behind a capacity-blocked
// plugin that sorts earlier.
func TestReleaseStopPendingStartWaitsBehindEarlierWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")

	releaseStopWithPendingStartForTest(t, supervisor, waiter, own)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if got := supervisor.Status(own.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("plugin with the pending start state = %q, want %q", got, StateCapacityBlocked)
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter that sorts earlier did not get the released slot")
	}
}

// The same, with the waiter sorting later: the plugin's own pending start is decided before admission, so it wins the
// slot it released and the waiter stays blocked.
func TestReleaseStopPendingStartWinsAgainstLaterWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("beta")
	own := enabledSpec("alpha")

	releaseStopWithPendingStartForTest(t, supervisor, waiter, own)
	receiveStartedForTest(t, started, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	if !supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("plugin with the pending start did not get the slot")
	}
}

// replaceFixtureForTest holds one slot: beta runs a registered process and is replaced by a changed spec, alpha sorts
// first and is capacity-blocked. The returned run is the lifecycle start of beta, active throughout.
func replaceFixtureForTest(t *testing.T) (
	supervisor *Supervisor,
	started <-chan string,
	waiter, changed ServiceSpec,
	done *processExit,
	operation lifecycleOperation,
) {
	t.Helper()

	supervisor, started = newAdmissionSupervisorForTest(t)
	supervisor.cfg.StopTimeout = 5 * time.Millisecond
	supervisor.cfg.FinalReapTimeout = 15 * time.Millisecond
	waiter = enabledSpec("alpha")
	own := enabledSpec("beta")
	changed = own
	changed.Args = []string{"--changed"}
	done = newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, changed}); !containsID(plan.startIDs, own.PluginID) {
		t.Fatalf("start IDs = %#v, want %q", plan.startIDs, own.PluginID)
	}

	operation = supervisor.beginLifecycleOperation(own.PluginID, OpStarting, IntentRun)

	if plan := supervisor.planStart(changed, RuntimePaths{}); plan.action != startReplace || plan.err != nil {
		t.Fatalf("plan for the changed spec = (%d, %v), want (%d, nil)", plan.action, plan.err, startReplace)
	}

	return supervisor, started, waiter, changed, done, operation
}

// timedOutDisableFixtureForTest leaves beta's release stop in flight after its timeout. An optional alpha waiter owns
// no slot and sorts ahead of beta.
func timedOutDisableFixtureForTest(t *testing.T, waiter *ServiceSpec) (
	supervisor *Supervisor,
	started <-chan string,
	own ServiceSpec,
	done *processExit,
) {
	t.Helper()

	supervisor, started = newAdmissionSupervisorForTest(t)
	supervisor.cfg.StopTimeout = 5 * time.Millisecond
	supervisor.cfg.FinalReapTimeout = 15 * time.Millisecond
	own = enabledSpec("beta")
	done = newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady}, nil, done)

	specs := []ServiceSpec{own}

	if waiter != nil {
		specs = append(specs, *waiter)
	}

	supervisor.Reconcile(context.Background(), specs)

	disabled := own
	disabled.Enabled = false
	disabledSpecs := []ServiceSpec{disabled}

	if waiter != nil {
		disabledSpecs = append(disabledSpecs, *waiter)
	}

	if plan := supervisor.Reconcile(context.Background(), disabledSpecs); !containsID(plan.stopIDs, own.PluginID) {
		t.Fatalf("disable reconcile stop IDs = %#v, want %q", plan.stopIDs, own.PluginID)
	}

	operation := supervisor.beginLifecycleOperation(own.PluginID, OpStopping, IntentStop)

	if operation.token == nil {
		t.Fatal("disable lifecycle operation did not begin")
	}

	stopErr := supervisor.stopServiceForLifecycle(operation.token)

	if stopErr == nil {
		t.Fatal("disable stop = nil, want the timeout error")
	}

	supervisor.failLifecycle(operation.token, stopErr)

	return supervisor, started, own, done
}

func TestReenableDuringTimedOutDisableStartsAtCleanup(t *testing.T) {
	supervisor, started, own, done := timedOutDisableFixtureForTest(t, nil)

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{own}); len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the disable stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("reenable during the stop did not leave a pending start")
	}

	requireNothingStartedForTest(t, supervisor, started)
	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, own.PluginID)
	receiveStartedForTest(t, started, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the pending start was admitted")

	if !supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("reenabled plugin did not own the slot after cleanup")
	}
}

func TestReenableDuringTimedOutDisableQueuesBehindEarlierWaiter(t *testing.T) {
	waiter := enabledSpec("alpha")
	supervisor, started, own, done := timedOutDisableFixtureForTest(t, &waiter)

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state before cleanup = %q, want %q", got, StateCapacityBlocked)
	}

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own}); len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the disable stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("reenable during the stop did not leave a pending start")
	}

	requireNothingStartedForTest(t, supervisor, started)
	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, own.PluginID)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the earlier waiter was admitted")

	if got := supervisor.Status(own.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("reenabled plugin state after cleanup = %q, want %q", got, StateCapacityBlocked)
	}

	if supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("reenabled plugin took a slot from the earlier waiter")
	}

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{own}); !containsID(plan.removeIDs, waiter.PluginID) {
		t.Fatalf("reconcile after removing the waiter returned remove IDs = %#v, want %q", plan.removeIDs, waiter.PluginID)
	}

	if err := supervisor.stopProcess(context.Background(), waiter.PluginID, stopRelease); err != nil {
		t.Fatalf("removed waiter's stop = %v, want nil", err)
	}

	receiveStartedForTest(t, started, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if !supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("queued plugin did not get the slot after the earlier waiter was removed")
	}
}

func TestNewSpecDuringTimedOutReplaceRestartsWithIt(t *testing.T) {
	supervisor, _, waiter, changed, done, operation := replaceFixtureForTest(t)

	stopErr := supervisor.stopProcess(context.Background(), changed.PluginID, stopRestart)

	if stopErr == nil {
		t.Fatal("replace stop = nil, want the timeout error")
	}

	supervisor.failLifecycle(operation.token, stopErr)

	latest := changed
	latest.Args = []string{"--latest"}

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, latest}); len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the replacement stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(changed.PluginID).pendingStart {
		t.Fatal("new spec during the stop did not replace the pending restart")
	}

	started := make(chan ServiceSpec, 2)
	supervisor.startDesired = func(spec ServiceSpec) { started <- spec }

	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, changed.PluginID)

	select {
	case got := <-started:
		if !got.Equal(latest) {
			t.Fatalf("restarted spec = %+v, want %+v", got, latest)
		}
	case <-time.After(time.Second):
		t.Fatal("latest spec was not started after cleanup")
	}

	waitStartupsIdleForTest(supervisor)

	select {
	case got := <-started:
		t.Fatalf("unexpected additional startup of %+v", got)
	default:
	}

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	if !supervisor.pluginSnapshot(changed.PluginID).serviceSlotHeld {
		t.Fatal("restarting plugin lost its slot")
	}
}

func TestIncompatibleSpecDuringStopReleasesSlotAtCleanup(t *testing.T) {
	supervisor, started, waiter, changed, done, operation := replaceFixtureForTest(t)

	stopErr := supervisor.stopProcess(context.Background(), changed.PluginID, stopRestart)

	if stopErr == nil {
		t.Fatal("replace stop = nil, want the timeout error")
	}

	supervisor.failLifecycle(operation.token, stopErr)

	incompatible := changed
	incompatible.ProtocolVersion = 9

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, incompatible}); len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the replacement stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(changed.PluginID).pendingStart {
		t.Fatal("incompatible spec during the stop did not leave a pending restart")
	}

	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, changed.PluginID)
	receiveStartedSetForTest(t, started, waiter.PluginID, changed.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the incompatible restart released its slot")

	if supervisor.pluginSnapshot(changed.PluginID).serviceSlotHeld {
		t.Fatal("incompatible restart kept the old slot")
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("earlier waiter did not get the released slot")
	}
}

func TestDisableAfterReenableDuringStopStartsNothing(t *testing.T) {
	waiter := enabledSpec("alpha")
	supervisor, started, own, done := timedOutDisableFixtureForTest(t, &waiter)

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own}); len(plan.startIDs) != 0 {
		t.Fatalf("reenable reconcile during the stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("reenable during the stop did not leave a pending start")
	}

	disabled := own
	disabled.Enabled = false

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, disabled}); len(plan.startIDs) != 0 {
		t.Fatalf("disable reconcile during the stop planned starts = %v, want none", plan.startIDs)
	}

	if supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("disable during the stop left a pending restart")
	}

	requireNothingStartedForTest(t, supervisor, started)
	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, own.PluginID)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the disabled plugin released its slot")

	if supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("disabled plugin kept its slot")
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("earlier waiter did not get the released slot")
	}
}

func TestReconcileStartDuringStopIsDroppedAfterLaterRun(t *testing.T) {
	supervisor, started, own, done := timedOutDisableFixtureForTest(t, nil)

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{own}); len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the disable stop planned starts = %v, want none", plan.startIDs)
	}

	if !supervisor.pluginSnapshot(own.PluginID).pendingStart {
		t.Fatal("reenable during the stop did not leave a pending start")
	}

	// This pins the generation term in pendingStartEligibleLocked: the later lifecycle run advances it, so cleanup drops
	// Reconcile's pending start. Leaving the plugin Stopped is today's behavior tracked in TASK-48.
	run := supervisor.beginLifecycleOperation(own.PluginID, OpStarting, IntentRun)

	if run.token == nil {
		t.Fatal("later lifecycle run did not begin")
	}

	supervisor.failLifecycle(run.token, errors.New("startup work failed"))

	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if supervisor.pluginSnapshot(own.PluginID).serviceSlotHeld {
		t.Fatal("plugin whose pending start was superseded kept a slot")
	}
}

func requireSlotsForTest(t *testing.T, supervisor *Supervisor, want int, when string) {
	t.Helper()

	if got := supervisor.reservedServiceCount(); got != want {
		t.Fatalf("reserved slots %s = %d, want %d", when, got, want)
	}
}

// A replaced plugin keeps its slot against a capacity-blocked plugin that sorts earlier. The test waits for the stop's
// cleanup before the replacing run plans again, which is the order that used to hand the freed slot to the waiter.
func TestReplaceKeepsSlotFromEarlierWaiter(t *testing.T) {
	supervisor, started, waiter, changed, done, _ := replaceFixtureForTest(t)

	close(done.done)

	if err := supervisor.stopProcess(context.Background(), changed.PluginID, stopRestart); err != nil {
		t.Fatalf("replace stop = %v, want nil", err)
	}

	waitForSupervisorStopForTest(t, supervisor, changed.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the stop's cleanup")

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state after the cleanup = %q, want %q", got, StateCapacityBlocked)
	}

	if plan := supervisor.planStart(changed, RuntimePaths{}); plan.action != startProceed || plan.err != nil {
		t.Fatalf("plan after the cleanup = (%d, %v), want (%d, nil)", plan.action, plan.err, startProceed)
	}

	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "once the replacement is planned")

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state after the replacement = %q, want %q", got, StateCapacityBlocked)
	}
}

// The replace stop times out, so the run ends with its error while the old process is still alive. The plugin keeps its
// slot through the timeout and the cleanup, the waiter stays blocked, and the restart continues with the new spec.
func TestTimedOutReplaceKeepsSlotFromEarlierWaiter(t *testing.T) {
	supervisor, started, waiter, changed, done, operation := replaceFixtureForTest(t)

	stopErr := supervisor.stopProcess(context.Background(), changed.PluginID, stopRestart)

	if stopErr == nil {
		t.Fatal("replace stop = nil, want the timeout error")
	}

	supervisor.failLifecycle(operation.token, stopErr)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the run ended with the timeout")

	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, changed.PluginID)
	receiveStartedForTest(t, started, changed.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the stop's cleanup")

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	if !supervisor.pluginSnapshot(changed.PluginID).serviceSlotHeld {
		t.Fatal("restarting plugin lost its slot")
	}
}

// A disable during the restart stop clears the pending start; cleanup releases the ownerless slot and admits the
// waiter in the same critical section.
// Cleanup lands before the disable's planned stop reaches stopProcess. If the planned stop wins the race, its join
// upgrades the in-flight stop to stopRelease and releases the slot through finishStop instead.
func TestReplaceWhoseRestartDoesNotContinueReleasesSlot(t *testing.T) {
	supervisor, started, waiter, changed, done, operation := replaceFixtureForTest(t)

	stopErr := supervisor.stopProcess(context.Background(), changed.PluginID, stopRestart)

	if stopErr == nil {
		t.Fatal("replace stop = nil, want the timeout error")
	}

	supervisor.failLifecycle(operation.token, stopErr)

	disabled := changed
	disabled.Enabled = false

	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, disabled})

	if len(plan.startIDs) != 0 {
		t.Fatalf("reconcile during the replacement stop planned starts = %v, want none", plan.startIDs)
	}

	if !containsID(plan.stopIDs, changed.PluginID) {
		t.Fatalf("disable reconcile stop IDs = %#v, want %q", plan.stopIDs, changed.PluginID)
	}

	if supervisor.pluginSnapshot(changed.PluginID).pendingStart {
		t.Fatal("disable during the replacement stop left a pending start")
	}

	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "while the stop is in flight")

	close(done.done)
	waitForSupervisorStopForTest(t, supervisor, changed.PluginID)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)
	requireSlotsForTest(t, supervisor, 1, "after the stop's cleanup")

	if supervisor.pluginSnapshot(changed.PluginID).serviceSlotHeld {
		t.Fatal("plugin whose restart did not continue kept its slot")
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter was not admitted when the slot was released")
	}
}

// A plugin that crashes past the retry cutoff reaches StateFailed and gives its slot to the first waiter in the same
// critical section; starting it again asks the queue like any other start.
func TestFailedPluginReleasesSlotToWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady, ConsecutiveFailures: maxConsecutiveFailures - 1}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(own.PluginID, done)
	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	snapshot := supervisor.pluginSnapshot(own.PluginID)

	if snapshot.status.State != StateFailed || snapshot.serviceSlotHeld {
		t.Fatalf("failed plugin state = %q, slot held = %t, want %q and no slot", snapshot.status.State, snapshot.serviceSlotHeld, StateFailed)
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter was not admitted when the failed plugin gave its slot up")
	}

	supervisor.beginLifecycleOperation(own.PluginID, OpStarting, IntentRun)

	if plan := supervisor.planStart(own, RuntimePaths{}); plan.action != startNoop || !errors.Is(plan.err, ErrServiceCapacityExceeded) {
		t.Fatalf("plan for the failed plugin = (%d, %v), want (%d, %v)", plan.action, plan.err, startNoop, ErrServiceCapacityExceeded)
	}
}

// A start that fails at the retry cutoff inside its run reaches StateFailed too; the slot is released when that run
// ends, not before, and the waiter is admitted then. The cutoff count is seeded because production reaches it only
// after four earlier failures; the failure itself is a real one (the spec has no command to validate).
func TestFailedStartReleasesSlotWhenItsRunEnds(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")

	supervisor.Reconcile(context.Background(), []ServiceSpec{own})
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	supervisor.mu.Lock()

	supervisor.serviceRecordLocked(own.PluginID).service.status.ConsecutiveFailures = maxConsecutiveFailures - 1

	supervisor.unlock()

	if err := startSupervisorForTest(supervisor, own); err == nil {
		t.Fatal("start of a spec without a command = nil, want an error")
	}

	receiveStartedForTest(t, started, waiter.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	snapshot := supervisor.pluginSnapshot(own.PluginID)

	if snapshot.status.State != StateFailed || snapshot.serviceSlotHeld {
		t.Fatalf("failed plugin state = %q, slot held = %t, want %q and no slot", snapshot.status.State, snapshot.serviceSlotHeld, StateFailed)
	}

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter was not admitted when the failed start's run ended")
	}
}

// A stop that is already running keeps the stronger of the kinds asked of it: a disable that joins a replace stop makes
// it a release, and a replace that joins a release stop does not downgrade it. The run stays active so that a kept
// slot has an owner at cleanup; the slot is the only difference between the cases.
func TestStopJoinKeepsTheStrongerKind(t *testing.T) {
	tests := []struct {
		name         string
		first, again stopKind
		wantSlotHeld bool
	}{
		{name: "release joins restart", first: stopRestart, again: stopRelease},
		{name: "restart joins release", first: stopRelease, again: stopRestart},
		{name: "restart joins restart", first: stopRestart, again: stopRestart, wantSlotHeld: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			supervisor, _ := newAdmissionSupervisorForTest(t)
			supervisor.cfg.StopTimeout = 5 * time.Millisecond
			supervisor.cfg.FinalReapTimeout = 15 * time.Millisecond
			spec := enabledSpec("beta")
			done := newProcessExit()

			seedRegisteredServiceForTest(supervisor, spec, RuntimeStatus{State: StateReady}, nil, done)
			supervisor.beginLifecycleOperation(spec.PluginID, OpStarting, IntentRun)

			if err := supervisor.stopProcess(context.Background(), spec.PluginID, test.first); err == nil {
				t.Fatal("first stop = nil, want the timeout error")
			}

			joinCtx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)

			defer cancel()

			if err := supervisor.stopProcess(joinCtx, spec.PluginID, test.again); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("joining stop = %v, want the caller's deadline", err)
			}

			close(done.done)
			waitForSupervisorStopForTest(t, supervisor, spec.PluginID)

			if got := supervisor.pluginSnapshot(spec.PluginID).serviceSlotHeld; got != test.wantSlotHeld {
				t.Fatalf("slot held after the cleanup = %t, want %t", got, test.wantSlotHeld)
			}
		})
	}
}

// beta runs a registered process and alpha is capacity-blocked behind it. Reconcile brings beta a spec the daemon
// cannot run, and beta's process crashes before the startup run begins. The incompatible spec cannot start, so the
// slot is not kept: alpha is admitted in the exit's critical section, and beta keeps the status it crashed with,
// because no stop resets it.
func TestCrashWithIncompatibleDesiredSpecReleasesSlotToWaiter(t *testing.T) {
	supervisor, started := newAdmissionSupervisorForTest(t)
	waiter := enabledSpec("alpha")
	own := enabledSpec("beta")
	incompatible := own
	incompatible.ProtocolVersion = 9
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, own,
		RuntimeStatus{State: StateReady, ConsecutiveFailures: 2, LastError: "earlier"}, nil, done)
	supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, own})

	if got := supervisor.Status(waiter.PluginID).State; got != StateCapacityBlocked {
		t.Fatalf("waiter state = %q, want %q", got, StateCapacityBlocked)
	}

	if plan := supervisor.Reconcile(context.Background(), []ServiceSpec{waiter, incompatible}); !containsID(plan.startIDs, own.PluginID) {
		t.Fatalf("start IDs = %#v, want %q", plan.startIDs, own.PluginID)
	}

	done.err = errors.New("crash")

	close(done.done)
	supervisor.observeExit(own.PluginID, done)

	// The exit's tail returns two startup effects, the waiter's (admitted) and the plugin's own (it ends at the
	// incompatible protocol). Each runs in its own goroutine, so they arrive in either order; who got the slot is
	// checked below.
	receiveStartedSetForTest(t, started, waiter.PluginID, own.PluginID)
	requireNothingStartedForTest(t, supervisor, started)

	if !supervisor.pluginSnapshot(waiter.PluginID).serviceSlotHeld {
		t.Fatal("waiter was not given the slot of the plugin that cannot restart")
	}

	snapshot := supervisor.pluginSnapshot(own.PluginID)

	if snapshot.serviceSlotHeld || snapshot.reservationPending {
		t.Fatalf("crashed plugin still owns a slot: held=%t reserved=%t", snapshot.serviceSlotHeld, snapshot.reservationPending)
	}

	if snapshot.status.ConsecutiveFailures != 2 || snapshot.status.LastError != "earlier" {
		t.Fatalf("crashed plugin status = (failures %d, error %q), want (2, \"earlier\")",
			snapshot.status.ConsecutiveFailures, snapshot.status.LastError)
	}

	requireSlotsForTest(t, supervisor, 1, "after the crash")
}

// The stopper's context ends while it waits for the process, and the process exits inside the final reap. The stop is
// complete, so it records what the background finalizer would record, nil: a joiner and lastStopErr do not see the
// first caller's context error. That caller still hears its own.
func TestStopOfReapedProcessRecordsNoCallerContextError(t *testing.T) {
	supervisor, _ := newAdmissionSupervisorForTest(t)
	supervisor.cfg.StopTimeout = time.Minute
	supervisor.cfg.FinalReapTimeout = time.Minute
	own := enabledSpec("beta")
	done := newProcessExit()

	seedRegisteredServiceForTest(supervisor, own, RuntimeStatus{State: StateReady}, nil, done)

	canceled, cancel := context.WithCancel(context.Background())

	cancel()

	stopperCtx := &observedDoneContext{Context: canceled, observed: make(chan struct{})}
	stopperResult := make(chan error, 1)

	go func() {
		stopperResult <- supervisor.stopProcess(stopperCtx, own.PluginID, stopRelease)
	}()

	// The stopper asks for Done only once it waits in the final reap, with its context already ended.
	select {
	case <-stopperCtx.observed:
	case <-time.After(time.Second):
		t.Fatal("stopper did not reach the final reap")
	}

	joinerCtx := &observedDoneContext{Context: context.Background(), observed: make(chan struct{})}
	joinerResult := make(chan error, 1)

	go func() {
		joinerResult <- supervisor.stopProcess(joinerCtx, own.PluginID, stopKeep)
	}()

	select {
	case <-joinerCtx.observed:
	case <-time.After(time.Second):
		t.Fatal("joiner did not reach its wait")
	}

	close(done.done)

	var stopperErr, joinerErr error

	for range 2 {
		select {
		case stopperErr = <-stopperResult:
		case joinerErr = <-joinerResult:
		case <-time.After(time.Second):
			t.Fatal("stop did not finish")
		}
	}

	if !errors.Is(stopperErr, context.Canceled) {
		t.Fatalf("stopper error = %v, want its own context error", stopperErr)
	}

	if joinerErr != nil {
		t.Fatalf("joiner error = %v, want nil", joinerErr)
	}

	supervisor.mu.Lock()

	lastStopErr := supervisor.serviceRecordLocked(own.PluginID).service.lastStopErr

	supervisor.unlock()

	if lastStopErr != nil {
		t.Fatalf("lastStopErr = %v, want nil", lastStopErr)
	}
}
