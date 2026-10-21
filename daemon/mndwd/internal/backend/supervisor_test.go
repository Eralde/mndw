package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestReconcileSeedsEnabledStartupCandidate(t *testing.T) {
	supervisor := newSupervisor(testSupervisorConfig(t), NewAdmission(Limits{MaxSupervisedServices: 4}))
	plan := supervisor.Reconcile(context.Background(), []ServiceSpec{enabledSpec("svc")})

	if !containsID(plan.startIDs, "svc") {
		t.Fatal("initial reconcile did not return enabled startup candidate")
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

	supervisor.withLock(func() { supervisor.coord.begin("svc", OpDeleting, IntentRemove) })

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
	record := &serviceRecord{status: RuntimeStatus{State: StateStarting}}
	supervisor.services["svc"] = record

	supervisor.beginLifecycle("svc", OpDeleting, IntentRemove)
	supervisor.failStart(start.run, "svc", errors.New("late failure"))
	supervisor.markServiceReady(start.run, record)

	if got := supervisor.Status("svc").State; got != StateStarting {
		t.Fatalf("stale startup changed service state to %q", got)
	}
}

func testSupervisorConfig(t *testing.T) SupervisorConfig {
	t.Helper()

	return normalizeSupervisorConfig(SupervisorConfig{
		RuntimeRoot:        t.TempDir(),
		SupportedProtocols: []int{1},
		Limits:             Limits{MaxSupervisedServices: 4},
	})
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

func TestNormalizeSupervisorConfigAppliesDefaults(t *testing.T) {
	now := func() time.Time { return time.Unix(123, 0) }
	cfg := normalizeSupervisorConfig(SupervisorConfig{Now: now})

	if cfg.Limits.MaxSupervisedServices != 8 {
		t.Fatalf("MaxSupervisedServices = %d, want 8", cfg.Limits.MaxSupervisedServices)
	}

	if cfg.ReadinessTimeout != 30*time.Second || cfg.StopTimeout != 10*time.Second || cfg.DiagnosticsTimeout != 2*time.Second || cfg.FinalReapTimeout != 2*time.Second {
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

	first, ok := supervisor.admission.TryReserveService("first")

	if !ok {
		t.Fatal("first service reservation rejected")
	}

	defer first.Release()

	if _, ok := supervisor.admission.TryReserveService("second"); ok {
		t.Fatal("second service reservation accepted")
	}
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
	reservation, ok := supervisor.admission.TryReserveService("occupied")

	if !ok {
		t.Fatal("occupied service reservation rejected")
	}

	defer reservation.Release()

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
	supervisor.withLock(func() {
		if err == nil {
			supervisor.coord.commit(outcome.run)
		} else {
			supervisor.coord.failRestore(outcome.run, err)
		}
	})

	return err
}

func stopSupervisorForTest(supervisor *Supervisor, pluginID string) error {
	outcome := supervisor.beginLifecycle(pluginID, OpDeleting, IntentRemove)
	err := supervisor.stopService(outcome.run)

	close(outcome.run.workDone)
	supervisor.withLock(func() {
		if err == nil {
			supervisor.coord.commit(outcome.run)
		} else {
			supervisor.coord.fail(outcome.run, err)
		}
	})

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
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return base }}),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	record := &serviceRecord{status: RuntimeStatus{State: StateStarting}}
	supervisor.services["svc"] = record

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
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }}),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	record := &serviceRecord{status: RuntimeStatus{State: StateReady, ConsecutiveFailures: 0}}
	supervisor.services["svc"] = record

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
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}}),
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
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 1}}),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	occupied, ok := supervisor.admission.TryReserveService("occupied")

	if !ok {
		t.Fatal("occupied reservation rejected")
	}

	defer occupied.Release()

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
}

func TestPlanStartProceedReservesAndMarksStarting(t *testing.T) {
	supervisor := newSupervisor(
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return time.Unix(1_000, 0) }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 2}}),
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
		normalizeSupervisorConfig(SupervisorConfig{Now: func() time.Time { return now }, SupportedProtocols: []int{1}, Limits: Limits{MaxSupervisedServices: 1}}),
		NewAdmission(Limits{MaxSupervisedServices: 1}),
	)
	future := now.Add(5 * time.Second)
	supervisor.services["svc"] = &serviceRecord{status: RuntimeStatus{State: StateBackoff, NextAttemptAt: &future}}

	paths, err := NewRuntimePaths(t.TempDir(), "svc")
	if err != nil {
		t.Fatalf("paths: %v", err)
	}

	plan := supervisor.planStart(ServiceSpec{PluginID: "svc", ProtocolVersion: 1, Enabled: true}, paths)

	if plan.action != startNoop || plan.err == nil {
		t.Fatalf("action=%d err=%v, want startNoop + backoff error", plan.action, plan.err)
	}
}
