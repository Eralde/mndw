package backend

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"testing"
)

// The launch events are the steps startService takes after planStartLocked: the launch ends or the child is attached,
// the child is registered, readiness passes or fails. Each takes the mutex itself, so these are drive rows: the row
// seeds the state, calls the step and compares the projection plus what the step returned. beginServiceLaunch, the
// first step, is in TestRuleStopProcPairs next to the stop it must not meet.
//
// ProbeReadiness talks to a real socket and decides nothing about the model; its answer reaches the rules as the
// arguments of failStart and cleanupFailedStart, which have rows here.

var (
	// launchIdle is a start in its launch: the run is current and the plugin holds its slot.
	launchIdle = recStopped().with(op(OpStarting), inState(StateStarting), slot(slotHeld))
	// launchStarted is a child that was started and is not registered yet.
	launchStarted = launchIdle.with(proc("started"))
	// launchRegistered is a registered child whose readiness is being probed.
	launchRegistered = launchIdle.with(proc("registered"))
)

// newLaunchChild is a child no record owns: it has an identity of its own and an exit that never closes.
func newLaunchChild() *registeredProcess {
	return &registeredProcess{
		id:      1 << 20,
		exit:    newProcessExit(),
		command: &exec.Cmd{Process: &os.Process{Pid: ruleNoSuchPID}},
	}
}

// finishFailedLaunch ends a launch whose child never started.
func TestRuleFinishFailedLaunch(t *testing.T) {
	finish := func(launchOf func(h *ruleHarness) *launchIdentity, recordOf func(h *ruleHarness) *pluginRecord) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			launch := launchOf(h)

			h.s.finishFailedLaunch("beta", recordOf(h), launch)

			select {
			case <-launch.done:
				return "launch closed"
			default:
				return "launch open"
			}
		}
	}
	own := func(h *ruleHarness) *launchIdentity { return h.launch["beta"] }
	current := func(h *ruleHarness) *pluginRecord {
		h.s.mu.Lock()

		defer h.s.mu.Unlock()

		return h.s.plugins["beta"]
	}
	launching := launchIdle.with(proc("launching"))

	runTable(t, []ruleRow{
		{
			name:  "launch failed: the launch is ended and its waiters are released",
			start: []rulePlugin{plug("beta", launching)},
			drive: finish(own, current),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launchIdle}, out: "launch closed"},
		},
		{
			name:  "launch failed: a launch that is not the record's launch changes nothing",
			start: []rulePlugin{plug("beta", launching)},
			drive: finish(func(*ruleHarness) *launchIdentity { return &launchIdentity{done: make(chan struct{})} }, current),
			want:  ruleWant{out: "launch open"},
		},
		{
			name:  "launch failed: a record the supervisor replaced changes nothing",
			start: []rulePlugin{plug("beta", launching)},
			drive: finish(own, func(*ruleHarness) *pluginRecord { return &pluginRecord{} }),
			want:  ruleWant{out: "launch open"},
		},
	})
}

// attachStartedProcess gives the child to the record: the launch phase becomes the started phase.
func TestRuleAttachStartedProcess(t *testing.T) {
	attach := func(h *ruleHarness) string {
		launch := h.launch["beta"]

		h.s.mu.Lock()

		record := h.s.plugins["beta"]

		h.s.unlock()

		h.s.attachStartedProcess(record, launch, newLaunchChild())

		select {
		case <-launch.done:
			return "launch closed"
		default:
			return "launch open"
		}
	}

	runTable(t, []ruleRow{
		{
			name:  "attach: the child takes the launch's place and the launch is ended",
			start: []rulePlugin{plug("beta", launchIdle.with(proc("launching")))},
			drive: attach,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launchStarted}, out: "launch closed"},
		},
		{
			name: "guard: attach: a launch that was already cleared is not closed again",
			guard: "the writers of the phase are beginServiceLaunch, finishFailedLaunch (this goroutine, and attach is not called " +
				"after it), attach, registerServiceProcess, observeProcessExit (started after readiness, supervisor.go:1995) and " +
				"finishStop (stopProcess waits for a launch before creating a stop, supervisor.go:2595-2641); none clears a launch " +
				"another goroutine still attaches to",
			start: []rulePlugin{plug("beta", launchIdle.with(proc("launching")))},
			prep: func(h *ruleHarness) {
				h.s.plugins["beta"].service.proc = nil
			},
			drive: attach,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launchStarted}, out: "launch open"},
		},
	})
}

// registerServiceProcess makes the started child the record's registered child, if the run is still the plugin's.
func TestRuleRegisterServiceProcess(t *testing.T) {
	register := func(h *ruleHarness) string {
		h.s.mu.Lock()

		record := h.s.plugins["beta"]
		process := h.process["beta"]

		h.s.unlock()

		// The lease file is written from the child's identity in /proc; it is platform I/O, not a model rule.
		registered := h.s.registerServiceProcess(h.run["beta"], record, "beta", RuntimePaths{}, process, NewStderrRing(1024, 8))

		h.s.mu.Lock()

		defer h.s.unlock()

		return fmt.Sprintf("registered=%v stderr=%v", registered, record.service.recentStderr != nil)
	}
	canceled := func(h *ruleHarness) { h.run["beta"].cancel() }

	runTable(t, []ruleRow{
		{
			name:  "register: a started child of the current run is registered",
			start: []rulePlugin{plug("beta", launchStarted)},
			drive: register,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launchRegistered}, out: "registered=true stderr=true"},
		},
		{
			name:  "register: a run that is no longer the plugin's current run does not register the child",
			start: []rulePlugin{plug("beta", launchStarted.with(op(OpNone)))},
			drive: register,
			want:  ruleWant{out: "registered=false stderr=false"},
		},
		{
			name:  "register: a run another run replaced does not register the child, though its context is alive",
			start: []rulePlugin{plug("beta", launchStarted)},
			prep: func(h *ruleHarness) {
				h.s.plugins["beta"].transition.run = h.s.newRunLocked("beta", OpStarting, IntentRun)
			},
			drive: register,
			want:  ruleWant{out: "registered=false stderr=false"},
		},
		{
			name:  "register: a canceled run does not register the child",
			start: []rulePlugin{plug("beta", launchStarted)},
			prep:  canceled,
			drive: register,
			want:  ruleWant{out: "registered=false stderr=false"},
		},
		{
			name: "guard: register: once shutdown started the child is not registered",
			guard: "StopAll cancels every current run in the section that sets shuttingDown (supervisor.go:1148-1152) and the " +
				"lifetime hook cancels the context every run derives from (supervisor.go:448-450, :799-803), and registration checks run.ctx (supervisor.go:2069-2070)",
			shutting: true,
			start:    []rulePlugin{plug("beta", launchStarted)},
			drive:    register,
			want:     ruleWant{out: "registered=false stderr=false"},
		},
		{
			name: "guard: register: a record whose child is not the started child is left alone",
			guard: "the phase of a current run's child is written only by that run's goroutine (begin, attach, register) and by " +
				"finishStop, which needs a stop, and a stop on a started child comes with a canceled run (StopAll, " +
				"reapUnregisteredProcess after supersession): writers of proc are supervisor.go:2017, :2028, :2045, :2073, :2278, :2753",
			start: []rulePlugin{plug("beta", launchStarted)},
			prep: func(h *ruleHarness) {
				h.process["beta"] = newLaunchChild()
			},
			drive: register,
			want:  ruleWant{out: "registered=false stderr=false"},
		},
	})
}

// markServiceReady is the end of a start: the status becomes ready if the run is still the plugin's.
func TestRuleRefreshServiceLease(t *testing.T) {
	refresh := func(h *ruleHarness) string {
		h.s.mu.Lock()

		record := h.s.plugins["beta"]
		process := h.process["beta"]

		h.s.unlock()

		refreshed := h.s.refreshServiceLease(h.run["beta"], record, RuntimePaths{}, process)

		h.s.mu.Lock()

		defer h.s.unlock()

		return fmt.Sprint(refreshed)
	}
	canceled := func(h *ruleHarness) { h.run["beta"].cancel() }

	runTable(t, []ruleRow{
		{
			name:  "refresh lease: the registered child of the current run is refreshed",
			start: []rulePlugin{plug("beta", launchRegistered)},
			drive: refresh,
			want:  ruleWant{out: "true"},
		},
		{
			name:  "refresh lease: a replaced run cannot refresh its child",
			start: []rulePlugin{plug("beta", launchRegistered)},
			prep: func(h *ruleHarness) {
				h.s.plugins["beta"].transition.run = h.s.newRunLocked("beta", OpStarting, IntentRun)
			},
			drive: refresh,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "refresh lease: a canceled run cannot refresh its child",
			start: []rulePlugin{plug("beta", launchRegistered)},
			prep:  canceled,
			drive: refresh,
			want:  ruleWant{out: "false"},
		},
		{
			name: "guard: refresh lease: shutdown refuses the write",
			guard: "StopAll sets shuttingDown and cancels current runs in one critical section (supervisor.go:1141-1152), so " +
				"there is no production state with shutdown set and a live current run",
			shutting: true,
			start:    []rulePlugin{plug("beta", launchRegistered)},
			drive:    refresh,
			want:     ruleWant{out: "false"},
		},
		{
			name: "guard: refresh lease: a different child cannot refresh the registered child's lease",
			guard: "the current run's child is written by its own run through begin, attach, register, or ready-exit cleanup; " +
				"finishStop requires a stop, and a stop with this active run is ruled out by supervisor.go:2017, :2028, :2045, " +
				":2073, :2278, :2753",
			start: []rulePlugin{plug("beta", launchRegistered)},
			prep: func(h *ruleHarness) {
				h.process["beta"] = newLaunchChild()
			},
			drive: refresh,
			want:  ruleWant{out: "false"},
		},
	})
}

func TestRuleMarkServiceReady(t *testing.T) {
	ready := func(h *ruleHarness) string {
		h.s.mu.Lock()

		record := h.s.plugins["beta"]

		h.s.unlock()

		marked := h.s.markServiceReady(h.run["beta"], record)

		h.s.mu.Lock()

		defer h.s.unlock()

		return fmt.Sprintf("ready=%v startedAt=%v", marked, record.service.status.StartedAt != nil)
	}

	runTable(t, []ruleRow{
		{
			name:  "ready: a registered child of the current run makes the plugin ready",
			start: []rulePlugin{plug("beta", launchRegistered.with(nextAttempt("future")))},
			drive: ready,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launchRegistered.with(inState(StateReady))}, out: "ready=true startedAt=true"},
		},
		{
			// Mirrors TestStaleStartupCannotPublishFailureOrReadiness.
			name:  "ready: a run that is no longer the plugin's current run changes nothing",
			start: []rulePlugin{plug("beta", launchRegistered.with(op(OpNone)))},
			drive: ready,
			want:  ruleWant{out: "ready=false startedAt=false"},
		},
	})
}

// failStart records a failed start as a failure with a retry, if the run is still the plugin's.
func TestRuleFailStart(t *testing.T) {
	fail := func(h *ruleHarness) string {
		h.s.failStart(h.run["beta"], "beta", errors.New("probe failed"))

		return "failed"
	}

	runTable(t, []ruleRow{
		{
			name:  "fail start: the current run's failure waits in backoff and schedules its retry",
			start: []rulePlugin{plug("beta", launchIdle)},
			drive: fail,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": launchIdle.with(inState(StateBackoff), failures(1), nextAttempt("future"), withRetry())},
				out:     "failed",
			},
		},
		{
			// Mirrors TestStaleStartupCannotPublishFailureOrReadiness.
			name:  "fail start: a run that is no longer the plugin's current run records nothing",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry()))},
			drive: fail,
			want:  ruleWant{out: "failed"},
		},
		{
			name:  "fail start: a plugin without a service record records nothing",
			start: []rulePlugin{plug("beta", launchIdle.with(noService(), op(OpStarting)))},
			drive: fail,
			want:  ruleWant{out: "failed"},
		},
	})
}

// cleanupFailedStart is the keep stop a failed readiness runs on the registered child, in its own bounded window.
func TestRuleCleanupFailedStart(t *testing.T) {
	runTable(t, []ruleRow{
		{
			name:  "cleanup: a registered child that exits is stopped and the stop keeps the slot and the starting status",
			start: []rulePlugin{plug("beta", launchRegistered)},
			drive: func(h *ruleHarness) string {
				h.closeExit("beta", nil)
				h.s.cleanupFailedStart("beta")

				return "cleaned"
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": launchIdle}, out: "cleaned"},
		},
		{
			name:  "cleanup: a child that does not exit leaves the keep stop in flight when the window ends, until the child exits",
			start: []rulePlugin{plug("beta", launchRegistered)},
			drive: func(h *ruleHarness) string {
				h.s.cleanupFailedStart("beta")

				inFlight := h.projectNow("beta")

				h.closeExit("beta", nil)
				h.waitForStop("beta")

				return fmt.Sprintf("returned stop=%q proc=%q", inFlight.Stop, inFlight.Proc)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": launchIdle}, out: `returned stop="keep" proc="registered"`},
		},
	})
}

// reapUnregisteredProcess releases a child that was started and never registered.
func TestRuleReapUnregisteredProcess(t *testing.T) {
	reap := func(h *ruleHarness) string {
		process := h.process["beta"]

		if h.exit["beta"] != nil {
			h.closeExit("beta", nil)
		}

		h.s.reapUnregisteredProcess("beta", process)

		return "reaped"
	}

	runTable(t, []ruleRow{
		{
			name:  "reap: a started child that was never registered is stopped and released",
			start: []rulePlugin{plug("beta", launchStarted)},
			drive: reap,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "reaped"},
		},
		{
			name:  "reap: a registered child is not the reaper's to stop",
			start: []rulePlugin{plug("beta", launchRegistered)},
			drive: func(h *ruleHarness) string {
				h.s.reapUnregisteredProcess("beta", h.process["beta"])

				return "reaped"
			},
			want: ruleWant{out: "reaped"},
		},
		{
			name:  "reap: a child the record does not own is not the reaper's to stop",
			start: []rulePlugin{plug("beta", launchStarted)},
			drive: func(h *ruleHarness) string {
				h.s.reapUnregisteredProcess("beta", newLaunchChild())

				return "reaped"
			},
			want: ruleWant{out: "reaped"},
		},
	})
}
