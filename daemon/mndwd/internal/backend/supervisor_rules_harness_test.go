package backend

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

// The rule tables read as the written state model: a row is a starting state, one event and the expected state and
// effects. The state is a comparable projection of what the model talks about (see ruleRec); the harness builds it
// under the supervisor mutex, runs the event, and compares the projection and the effects.
//
// A row is one of two kinds:
//   - locked: the event is a rule that runs under the mutex and returns effects. The whole row runs in one critical
//     section, effects are projected and never run, so a row sees the state a rule leaves before its tail runs. The
//     starting state is checked against the invariants unless the row says it starts inside a critical section.
//   - drive: the event does physical work through the existing fakes (a process exit, a stop, a retry callback). The
//     starting state is published with the checker on, the effects run, and the started set is compared as a set.

var ruleNow = time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)

// ruleNoSuchPID is the pid of a seeded child. A stop signals the child's process group, and no group has this id, so
// the signal finds nothing (ESRCH is not an error to terminateExecProcess).
const ruleNoSuchPID = 1<<31 - 1

// ruleRec is one plugin as the model sees it. It is both the seed and the projection, so a row reads the same before
// and after.
type ruleRec struct {
	Desired    string       // "" absent from the desired set, "off" disabled, otherwise the spec form
	Spec       string       // form of the service's own spec; meaningful only with a service record
	State      ServiceState // "" means no service record
	Failures   int
	Next       string // NextAttemptAt: "", "future" or "past" relative to the fixed clock
	Slot       slotState
	Proc       string // "", "launching", "started", "registered"
	Stop       string // "", "keep", "restart", "release"
	Pending    string // form of the pending start's spec, "+retry" appended for a retry request
	PendingGen string // "current" or "older" than the transition generation
	Retry      bool
	Startup    bool
	Intent     string // "" no transition record; "run", "stop", "remove"
	Op         Operation
	Prior      string // priorIntent of the transition record; "" means run
	Target     string // targetIntent of the run; "" means run
}

type rulePlugin struct {
	id      string
	rec     ruleRec
	healthy bool // the seeded process has been running for longer than healthyServiceDuration
}

func plug(id string, rec ruleRec) rulePlugin { return rulePlugin{id: id, rec: rec} }

type ruleWant struct {
	plugins map[string]ruleRec // full records of the plugins that change; the others must stay as seeded
	free    *int               // free slots; nil means unchanged
	effects []string           // startup effects returned by a locked row, in order
	started []string           // plugins whose startup ran in a drive row, compared as a set
	out     string
}

func freeSlots(count int) *int { return &count }

type ruleRow struct {
	name       string
	slots      int  // MaxSupervisedServices; defaults to 1
	shutting   bool // Supervisor.shuttingDown at the start
	start      []rulePlugin
	mid        string // non-empty: the row starts inside a critical section, so the checker does not judge the start
	guard      string // non-empty: the state is unreachable today; the reason
	retryDelay time.Duration
	prep       func(h *ruleHarness)                    // adjusts the seeded state under the mutex
	event      func(h *ruleHarness) ([]effect, string) // locked row
	drive      func(h *ruleHarness) string             // drive row
	want       ruleWant
}

type ruleTable struct {
	// tolerate lists invariants a row's end state may violate because the rule under test is only a part of its
	// event's critical section. Only TestRuleCompleteSuperseded uses it, for I9: inside beginLocked the superseded run
	// is replaced in the same section. `mid` rows do not use it: mid skips only the check of the starting state.
	tolerate []invariantID
}

type ruleHarness struct {
	t       *testing.T
	s       *Supervisor
	started chan string
	exit    map[string]*processExit
	stop    map[string]*stopState
	launch  map[string]*launchIdentity
	run     map[string]*operationRun
	process map[string]*registeredProcess
	// effects are the effects a drive row's event returned without running them (Reconcile hands them to its caller).
	effects []effect
	// retryFired receives the plugin ID each time a retry callback returns; a retry row waits on it.
	retryFired chan string
	// cancelLifetime ends the supervisor's lifetime context; the supervisor's own hook then runs on its goroutine.
	cancelLifetime context.CancelFunc
}

func specForm(spec ServiceSpec) string {
	if len(spec.Args) == 0 {
		return "base"
	}

	return spec.Args[0]
}

// ruleSpec builds the spec of a plugin in the given form: "base", "v2" and "v3" differ in their arguments, "proto9"
// requires a protocol the supervisor does not support.
func ruleSpec(id, form string) ServiceSpec {
	spec := enabledSpec(id)

	switch form {
	case "", "base":
	case "proto9":
		spec.ProtocolVersion = 9
		spec.Args = []string{form}
	case "builtin":
		spec.Builtin = true
		spec.Args = []string{form}
	default:
		spec.Args = []string{form}
	}

	return spec
}

var ruleIntents = map[string]Intent{"": IntentRun, "run": IntentRun, "stop": IntentStop, "remove": IntentRemove}

func intentName(intent Intent) string {
	switch intent {
	case IntentRun:
		return "run"
	case IntentStop:
		return "stop"
	default:
		return "remove"
	}
}

// defaultedIntentName is the name of an intent in a field where "" means run, so a row names only what differs.
func defaultedIntentName(intent Intent) string {
	if intent == IntentRun {
		return ""
	}

	return intentName(intent)
}

func newRuleHarness(t *testing.T, slots int, shutting bool) *ruleHarness {
	t.Helper()

	cfg := testSupervisorConfig(t)
	cfg.Limits.MaxSupervisedServices = max(slots, 1)
	cfg.StopTimeout = 10 * time.Millisecond
	cfg.FinalReapTimeout = 20 * time.Millisecond
	cfg.Now = func() time.Time { return ruleNow }

	lifetime, cancelLifetime := context.WithCancel(context.Background())
	cfg.LifetimeCtx = lifetime

	harness := &ruleHarness{
		t:       t,
		s:       newSupervisor(cfg, NewAdmission(cfg.Limits)),
		started: make(chan string, 16),
		exit:    map[string]*processExit{},
		stop:    map[string]*stopState{},
		launch:  map[string]*launchIdentity{},
		run:     map[string]*operationRun{},
		process: map[string]*registeredProcess{},

		retryFired:     make(chan string, 16),
		cancelLifetime: cancelLifetime,
	}
	harness.s.retryCallbackDone = func(id string) { harness.retryFired <- id }
	harness.s.startDesired = func(spec ServiceSpec) { harness.started <- spec.PluginID + ":" + specForm(spec) }
	harness.s.shuttingDown = shutting

	t.Cleanup(func() {
		harness.s.mu.Lock()
		harness.s.stopRetryTimersLocked()
		harness.s.mu.Unlock()
	})

	return harness
}

// seedLocked builds the starting state with the supervisor's own helpers where they exist and plain field writes
// where the state is exactly what the row says. Requires the mutex.
func (h *ruleHarness) seedLocked(start []rulePlugin, retryDelay time.Duration) {
	s := h.s

	for _, plugin := range start {
		id, rec := plugin.id, plugin.rec
		record := s.ensurePluginRecordLocked(id)

		switch rec.Desired {
		case "":
		case "off":
			spec := ruleSpec(id, "base")
			spec.Enabled = false
			record.desired = &spec
		default:
			spec := ruleSpec(id, rec.Desired)
			record.desired = &spec
		}

		if rec.Intent != "" {
			record.transition = &transitionState{intent: ruleIntents[rec.Intent], operation: rec.Op, priorIntent: ruleIntents[rec.Prior]}

			target := ruleIntents[rec.Target]
			op := rec.Op

			if op == OpNone {
				op = OpStarting
			}

			run := s.newRunLocked(id, op, target)
			record.transition.run = run
			h.run[id] = run

			if rec.Op == OpNone {
				run.completed = true

				run.cancel()
				close(run.done)
			}
		}

		if rec.State == "" {
			continue
		}

		service := &serviceState{
			spec:   ruleSpec(id, rec.Spec),
			status: RuntimeStatus{State: rec.State, ConsecutiveFailures: rec.Failures},
			slot:   rec.Slot,
		}
		record.service = service

		switch rec.Next {
		case "future":
			next := ruleNow.Add(time.Hour)
			service.status.NextAttemptAt = &next
		case "past":
			next := ruleNow.Add(-time.Second)
			service.status.NextAttemptAt = &next
		}

		if plugin.healthy {
			startedAt := ruleNow.Add(-2 * healthyServiceDuration)
			service.status.StartedAt = &startedAt
		}

		if rec.Slot != slotNone {
			s.reservedServices++
		}

		generation := s.transitionGenerationLocked(id)

		if rec.Pending != "" {
			form, retry := strings.CutSuffix(rec.Pending, "+retry")
			pendingGeneration := generation

			if rec.PendingGen == "older" {
				pendingGeneration = generation - 1
			}

			service.pending = &startRequest{spec: ruleSpec(id, form), retry: retry, generation: pendingGeneration}
		}

		switch rec.Proc {
		case "launching":
			s.nextProcessID++
			launch := &launchIdentity{id: s.nextProcessID, runGeneration: generation, done: make(chan struct{})}
			service.proc = procLaunching{launch: launch}
			h.launch[id] = launch
		case "started", "registered":
			s.nextProcessID++
			exit := newProcessExit()
			process := &registeredProcess{id: s.nextProcessID, runGeneration: generation, exit: exit, command: &exec.Cmd{Process: &os.Process{Pid: ruleNoSuchPID}}}

			if rec.Proc == "started" {
				service.proc = procStarted{process: process}
			} else {
				service.proc = procRegistered{process: process}
			}

			h.exit[id] = exit
			h.process[id] = process
		}

		if rec.Stop != "" {
			kinds := map[string]stopKind{"keep": stopKeep, "restart": stopRestart, "release": stopRelease}
			stop := &stopState{done: make(chan struct{}), kind: kinds[rec.Stop]}
			service.stop = stop
			h.stop[id] = stop
		}

		if rec.Startup {
			service.startup = &startupTicket{spec: ruleSpec(id, rec.Spec)}
		}

		if rec.Retry {
			s.scheduleRetry(id, retryDelay)
		}
	}
}

func (h *ruleHarness) projectLocked(id string) ruleRec {
	s := h.s
	record := s.plugins[id]
	rec := ruleRec{}

	if record == nil {
		return rec
	}

	switch {
	case record.desired == nil:
	case !record.desired.Enabled:
		rec.Desired = "off"
	default:
		rec.Desired = specForm(*record.desired)
	}

	if transition := record.transition; transition != nil {
		rec.Intent = intentName(transition.intent)
		rec.Op = transition.operation
		rec.Prior = defaultedIntentName(transition.priorIntent)

		if transition.run != nil {
			rec.Target = defaultedIntentName(transition.run.targetIntent)
		}
	}

	service := record.service

	if service == nil {
		return rec
	}

	rec.Spec = specForm(service.spec)
	rec.State = service.status.State
	rec.Failures = service.status.ConsecutiveFailures
	rec.Slot = service.slot
	rec.Retry = service.retry != nil
	rec.Startup = service.startup != nil

	switch next := service.status.NextAttemptAt; {
	case next == nil:
	case next.After(ruleNow):
		rec.Next = "future"
	default:
		rec.Next = "past"
	}

	switch service.proc.(type) {
	case procLaunching:
		rec.Proc = "launching"
	case procStarted:
		rec.Proc = "started"
	case procRegistered:
		rec.Proc = "registered"
	}

	if service.stop != nil {
		rec.Stop = map[stopKind]string{stopKeep: "keep", stopRestart: "restart", stopRelease: "release"}[service.stop.kind]
	}

	if pending := service.pending; pending != nil {
		rec.Pending = specForm(pending.spec)

		if pending.retry {
			rec.Pending += "+retry"
		}

		rec.PendingGen = "older"

		if pending.generation == s.transitionGenerationLocked(id) {
			rec.PendingGen = "current"
		}
	}

	return rec
}

func (h *ruleHarness) freeLocked() int {
	return h.s.cfg.Limits.MaxSupervisedServices - h.s.reservedServices
}

func projectEffects(effects []effect) []string {
	var names []string

	for _, current := range effects {
		if startup, ok := current.(startupEffect); ok {
			names = append(names, "start "+startup.spec.PluginID+":"+specForm(startup.spec))
		} else {
			names = append(names, fmt.Sprintf("%T", current))
		}
	}

	return names
}

func violationsExcept(violations []invariantViolation, tolerate []invariantID) []invariantViolation {
	var kept []invariantViolation

	for _, violation := range violations {
		if !slices.Contains(tolerate, violation.ID) {
			kept = append(kept, violation)
		}
	}

	return kept
}

func (h *ruleHarness) drainStarted() []string {
	var started []string

	for {
		select {
		case id := <-h.started:
			started = append(started, id)
		default:
			slices.Sort(started)

			return started
		}
	}
}

// runRuleTable runs every row as a subtest. A row is valid when its starting state is one production can reach, or it
// says why it is not (guard) or why it starts inside a critical section (mid).
func runRuleTable(t *testing.T, table ruleTable, rows []ruleRow) {
	t.Helper()

	seen := map[string]bool{}

	for _, row := range rows {
		if seen[row.name] {
			t.Fatalf("duplicate row name %q", row.name)
		}

		seen[row.name] = true

		t.Run(row.name, func(t *testing.T) {
			runRuleRow(t, table, row)
		})
	}
}

func runRuleRow(t *testing.T, table ruleTable, row ruleRow) {
	t.Helper()

	if (row.event == nil) == (row.drive == nil) {
		t.Fatal("a row needs exactly one of event and drive")
	}

	if row.guard != "" && !strings.HasPrefix(row.name, "guard: ") {
		t.Fatalf("a guard row's name starts with \"guard: \": %q", row.name)
	}

	if row.guard == "" && strings.HasPrefix(row.name, "guard: ") {
		t.Fatalf("row %q is named as a guard but gives no reason", row.name)
	}

	harness := newRuleHarness(t, row.slots, row.shutting)
	s := harness.s
	retryDelay := row.retryDelay

	if retryDelay == 0 {
		retryDelay = time.Hour
	}

	startFree := 0
	before := map[string]ruleRec{}

	var effects []effect
	var out string

	s.mu.Lock()

	harness.seedLocked(row.start, retryDelay)

	if row.prep != nil {
		row.prep(harness)
	}

	startFree = harness.freeLocked()

	for _, plugin := range row.start {
		before[plugin.id] = harness.projectLocked(plugin.id)
	}

	if row.guard == "" && row.mid == "" {
		if violations := s.checkInvariantsLocked(); len(violations) > 0 {
			s.mu.Unlock()
			t.Fatalf("the starting state breaks the invariants, so the row is not valid: %+v", violations)
		}
	}

	if row.event != nil {
		effects, out = row.event(harness)
	} else {
		// A drive row publishes its starting state: the checker judges it at this unlock, as everywhere else. A guard
		// or mid row may start in a state the checker rejects; the checker then stays off for the whole drive, so the
		// event's own unlocks are not judged either (nothing resets it: the supervisor is the row's alone).
		if (row.guard != "" || row.mid != "") && len(s.checkInvariantsLocked()) > 0 {
			s.invariantChecksOff = true
		}

		s.unlock()
	}

	if row.event == nil {
		out = row.drive(harness)
		effects = harness.effects

		// A startup counted but never run (a rule that queued a plugin twice, or whose effect nobody ran) would block
		// here for good; fail the row instead of hanging the package.
		s.mu.Lock()

		idle := s.startupsIdleLocked()

		s.unlock()

		select {
		case <-idle:
		case <-time.After(5 * time.Second):
			t.Fatal("a startup was counted whose effect nobody ran")
		}

		s.mu.Lock()
	}

	after := map[string]ruleRec{}

	for id := range before {
		after[id] = harness.projectLocked(id)
	}

	for id := range row.want.plugins {
		after[id] = harness.projectLocked(id)
	}

	endFree := harness.freeLocked()
	violations := violationsExcept(s.checkInvariantsLocked(), table.tolerate)

	if row.guard != "" {
		violations = nil // an unreachable state may be one the checker rejects; the row pins the rule, not the checker
	}

	s.mu.Unlock()

	for id, got := range after {
		want, changed := row.want.plugins[id]

		if !changed {
			want = before[id]
		}

		if got != want {
			t.Errorf("plugin %q after the event:\n got  %+v\n want %+v", id, got, want)
		}
	}

	wantFree := startFree

	if row.want.free != nil {
		wantFree = *row.want.free
	}

	if endFree != wantFree {
		t.Errorf("free slots = %d, want %d", endFree, wantFree)
	}

	if got := projectEffects(effects); !slices.Equal(got, row.want.effects) {
		t.Errorf("effects = %q, want %q", got, row.want.effects)
	}

	if got, want := harness.drainStarted(), slices.Sorted(slices.Values(row.want.started)); !slices.Equal(got, want) {
		t.Errorf("started = %q, want %q", got, want)
	}

	if out != row.want.out {
		t.Errorf("result = %q, want %q", out, row.want.out)
	}

	if len(violations) > 0 {
		t.Errorf("the end state breaks the invariants: %+v", violations)
	}
}

// waitForStop blocks until the plugin's current stop is finished, or fails the row.
func (h *ruleHarness) waitForStop(id string) {
	h.t.Helper()

	waitForSupervisorStopForTest(h.t, h.s, id)
}

// awaitRetry blocks until a retry callback has returned, or fails the row.
func (h *ruleHarness) awaitRetry(id string) {
	h.t.Helper()

	select {
	case got := <-h.retryFired:
		if got != id {
			h.t.Fatalf("retry callback for %q, want %q", got, id)
		}
	case <-time.After(5 * time.Second):
		h.t.Fatalf("retry callback for %q did not return", id)
	}
}

// closeExit lets the seeded child of a plugin exit, as the process wait goroutine does in production.
func (h *ruleHarness) closeExit(id string, err error) {
	exit := h.exit[id]
	exit.err = err

	close(exit.done)
}

// A row's plugins are built from a few shapes and small modifiers, so a row names only what makes it different.
type recMod func(*ruleRec)

func (r ruleRec) with(mods ...recMod) ruleRec {
	for _, mod := range mods {
		mod(&r)
	}

	return r
}

// recBlocked is a waiter in the admission queue: enabled, wants to run, no slot.
func recBlocked() ruleRec {
	return ruleRec{Desired: "base", Spec: "base", State: StateCapacityBlocked, Intent: "run"}
}

// recRunning is a plugin with a registered, ready process.
func recRunning() ruleRec {
	return ruleRec{Desired: "base", Spec: "base", State: StateReady, Slot: slotHeld, Proc: "registered", Intent: "run"}
}

// recBackoff is a crashed plugin that waits for its retry and keeps its slot.
func recBackoff() ruleRec {
	return ruleRec{Desired: "base", Spec: "base", State: StateBackoff, Slot: slotHeld, Intent: "run", Failures: 1, Next: "past"}
}

// recStopped is a stopped plugin that holds no slot.
func recStopped() ruleRec {
	return ruleRec{Desired: "base", Spec: "base", State: StateStopped, Intent: "run"}
}

func desired(form string) recMod        { return func(r *ruleRec) { r.Desired = form } }
func svcSpec(form string) recMod        { return func(r *ruleRec) { r.Spec = form } }
func inState(value ServiceState) recMod { return func(r *ruleRec) { r.State = value } }
func slot(value slotState) recMod       { return func(r *ruleRec) { r.Slot = value } }
func proc(phase string) recMod          { return func(r *ruleRec) { r.Proc = phase } }
func stopKindOf(kind string) recMod     { return func(r *ruleRec) { r.Stop = kind } }
func failures(count int) recMod         { return func(r *ruleRec) { r.Failures = count } }
func nextAttempt(when string) recMod    { return func(r *ruleRec) { r.Next = when } }
func intent(name string) recMod         { return func(r *ruleRec) { r.Intent = name } }
func op(value Operation) recMod         { return func(r *ruleRec) { r.Op = value } }
func prior(name string) recMod          { return func(r *ruleRec) { r.Prior = name } }
func target(name string) recMod         { return func(r *ruleRec) { r.Target = name } }
func withRetry() recMod                 { return func(r *ruleRec) { r.Retry = true } }
func withStartup() recMod               { return func(r *ruleRec) { r.Startup = true } }

func pending(form, generation string) recMod {
	return func(r *ruleRec) {
		r.Pending = form
		r.PendingGen = generation
	}
}

// noService drops the service record: the plugin is only wanted, or only has a transition.
func noService() recMod {
	return func(r *ruleRec) {
		*r = ruleRec{Desired: r.Desired, Intent: r.Intent, Op: r.Op, Prior: r.Prior, Target: r.Target}
	}
}

// onBeta runs a rule on beta's record under the mutex and reports its boolean answer.
func onBeta(call func(s *Supervisor, record *pluginRecord) bool) func(h *ruleHarness) ([]effect, string) {
	return func(h *ruleHarness) ([]effect, string) {
		return nil, fmt.Sprint(call(h.s, h.s.plugins["beta"]))
	}
}
