package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type observedDoneContext struct {
	context.Context
	observed chan struct{}
	once     sync.Once
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
		waitResult <- supervisor.stopProcess(waitCtx, "demo", false)
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
	record.process = nil
	record.processRegistered = false
	record.service.stop = nil

	supervisor.unlock()

	supervisor.resumePendingStartup(spec.PluginID)
	supervisor.startupWG.Wait()

	select {
	case got := <-started:
		t.Fatalf("pending start launched while its operation was current: %+v", got)
	default:
	}

	supervisor.mu.Lock()
	supervisor.commitLocked(operation.token.run)
	supervisor.unlock()

	select {
	case got := <-started:
		if !got.Equal(spec) {
			t.Fatalf("resumed spec = %+v, want %+v", got, spec)
		}
	case <-time.After(time.Second):
		t.Fatal("pending start was lost when its operation ended")
	}

	supervisor.startupWG.Wait()
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
