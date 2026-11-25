package backend

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// planStartLocked decides, inside a current run, whether the start proceeds, does nothing, replaces a running process
// or has to stop an incompatible one. It also records the pending start a changed spec leaves behind.
func TestRulePlanStart(t *testing.T) {
	plan := func(form string) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			plan := h.s.planStartLocked(ruleSpec("beta", form), RuntimePaths{})
			name := map[startAction]string{
				startNoop: "noop", startProceed: "proceed", startReplace: "replace", startStopIncompatible: "stop-incompatible",
			}[plan.action]
			out := fmt.Sprintf("%s err=%v", name, plan.err)

			if record := h.s.serviceRecordLocked("beta"); record != nil && record.service.status.Compatible != nil {
				out += fmt.Sprintf(" compatible=%v", *record.service.status.Compatible)
			}

			return plan.effects, out
		}
	}
	// supervisor.go:1801-1807 is the branch for Ready or Starting with no process. Ready without a process is I10, which
	// is enforced. Starting without a process is left only by a launch refused after planning (supervisor.go:1929-1932)
	// or by a keep cleanup (supervisor.go:2048) whose run was superseded by a Stop or Delete; their stop resets the
	// status (supervisor.go:2586, :2609). Otherwise StopAll or the lifetime canceled the run and planStartLocked has
	// returned already (supervisor.go:1724-1730).
	const noProcessReady = "Ready without a process is I10 (invariants.go:44); the audit of the writers of status.State is in the report, supervisor.go:1801"
	const noProcessStarting = "Starting without a process is left only by a launch refused after planning (supervisor.go:1929-1932) or by a keep cleanup " +
		"(supervisor.go:2048) whose run a Stop or Delete superseded, and their stop resets the status (supervisor.go:2586, :2609); " +
		"after StopAll or the lifetime planStartLocked returns before this branch (supervisor.go:1724-1730)"
	starting := op(OpStarting)
	fresh := ruleRec{Desired: "base", Intent: "run", Op: OpStarting}
	idle := recStopped().with(starting)
	held := recBackoff().with(starting, nextAttempt("future"))
	unsupported := "unsupported service protocol 9"
	launching := recStopped().with(starting, inState(StateStarting), slot(slotHeld), proc("launching"))
	capacity := ErrServiceCapacityExceeded.Error()
	lifetimeEnded := func(h *ruleHarness) {
		ctx, cancel := context.WithCancel(context.Background())

		cancel()

		h.s.lifetimeCtx = ctx
	}

	runTable(t, []ruleRow{
		{
			name:     "plan: once shutdown started nothing is planned",
			shutting: true,
			start:    []rulePlugin{plug("beta", idle)},
			event:    plan("base"),
			want:     ruleWant{out: "noop err=context canceled"},
		},
		{
			name:  "plan: after the lifetime context ended nothing is planned",
			start: []rulePlugin{plug("beta", idle)},
			prep:  lifetimeEnded,
			event: plan("base"),
			want:  ruleWant{out: "noop err=context canceled"},
		},
		{
			name:  "plan: a plugin without a service gets a record, a free slot and proceeds",
			start: []rulePlugin{plug("beta", fresh)},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": fresh.with(svcRecord("base", StateStarting, slotHeld))},
				free:    freeSlots(0),
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a reservation Reconcile made is claimed and the start proceeds",
			start: []rulePlugin{plug("beta", idle.with(slot(slotReservedByReconcile)))},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idle.with(slot(slotHeld), inState(StateStarting))},
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			// Mirrors TestPlanStartProceedReservesAndMarksStarting.
			name:  "plan: a stopped plugin without a slot takes a free one and proceeds",
			start: []rulePlugin{plug("beta", idle)},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idle.with(slot(slotHeld), inState(StateStarting))},
				free:    freeSlots(0),
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			// Mirrors TestPlanStartCapacityBlocked.
			name:  "plan: no free slot, the plugin queues as capacity-blocked",
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", idle)},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idle.with(inState(StateCapacityBlocked))},
				out:     "noop err=" + capacity + " compatible=true",
			},
		},
		{
			name:  "plan: a proceeding start drops the pending start it was recorded for",
			start: []rulePlugin{plug("beta", idle.with(pending("base", "current")))},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idle.with(slot(slotHeld), inState(StateStarting))},
				free:    freeSlots(0),
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			// Mirrors TestPlanStartBackoffNotElapsedIsNoop.
			name:  "plan: a plugin in backoff before its next attempt does nothing",
			start: []rulePlugin{plug("beta", held)},
			event: plan("base"),
			want:  ruleWant{out: "noop err=service is in backoff until 2026-11-25T13:00:00Z compatible=true"},
		},
		{
			name:  "plan: a plugin in backoff past its next attempt keeps its slot and proceeds",
			start: []rulePlugin{plug("beta", held.with(nextAttempt("past")))},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": held.with(inState(StateStarting), nextAttempt(""))},
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a changed spec restarts a plugin in backoff at once, the backoff does not apply to a new spec",
			start: []rulePlugin{plug("beta", held)},
			event: plan("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": held.with(desired("v2"), svcSpec("v2"), inState(StateStarting), nextAttempt(""))},
				out:     "proceed err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a ready process with the same spec is left alone",
			start: []rulePlugin{plug("beta", recRunning().with(starting))},
			event: plan("base"),
			want:  ruleWant{out: "noop err=<nil> compatible=true"},
		},
		{
			name:  "guard: plan: a ready plugin without a process with the same spec is left alone",
			guard: noProcessReady,
			start: []rulePlugin{plug("beta", launchIdle.with(inState(StateReady)))},
			event: plan("base"),
			want:  ruleWant{out: "noop err=<nil> compatible=true"},
		},
		{
			name:  "guard: plan: a starting plugin without a process with the same spec is left alone",
			guard: noProcessStarting,
			start: []rulePlugin{plug("beta", launchIdle)},
			event: plan("base"),
			want:  ruleWant{out: "noop err=<nil> compatible=true"},
		},
		{
			name:  "guard: plan: a starting plugin without a slot or a process with another spec is replaced",
			guard: noProcessStarting,
			start: []rulePlugin{plug("beta", launchIdle.with(slot(slotNone)))},
			event: plan("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": launchIdle.with(slot(slotNone), desired("v2"), svcSpec("v2"))},
				out:     "replace err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a stop in flight for the same spec records a pending start",
			start: []rulePlugin{plug("beta", recRunning().with(starting, stopKindOf("release")))},
			event: plan("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(starting, stopKindOf("release"), pending("base", "current"))},
				out:     "noop err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a registered process with another spec is replaced, the new spec waits as a pending start",
			start: []rulePlugin{plug("beta", recRunning().with(starting))},
			event: plan("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(starting, desired("v2"), pending("v2", "current"))},
				out:     "replace err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a child that is not registered yet with another spec is not replaced, only recorded",
			start: []rulePlugin{plug("beta", recRunning().with(starting, proc("started"), inState(StateStarting)))},
			event: plan("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(starting, proc("started"), inState(StateStarting), desired("v2"), pending("v2", "current"))},
				out:     "noop err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: a launch in flight with the same spec does nothing",
			start: []rulePlugin{plug("beta", launching)},
			event: plan("base"),
			want:  ruleWant{out: "noop err=<nil> compatible=true"},
		},
		{
			name:  "plan: a launch in flight with another spec records a pending start",
			start: []rulePlugin{plug("beta", launching)},
			event: plan("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": launching.with(desired("v2"), pending("v2", "current"))},
				out:     "noop err=<nil> compatible=true",
			},
		},
		{
			name:  "plan: an unsupported protocol with nothing to stop is reported and nothing is stopped",
			start: []rulePlugin{plug("beta", idle)},
			event: plan("proto9"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idle.with(desired("proto9"), svcSpec("proto9"))},
				out:     "noop err=" + unsupported + " compatible=false",
			},
		},
		{
			name:  "plan: an unsupported protocol on a plugin that holds a slot stops it",
			start: []rulePlugin{plug("beta", held)},
			event: plan("proto9"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": held.with(desired("proto9"), svcSpec("proto9"))},
				out:     "stop-incompatible err=" + unsupported + " compatible=false",
			},
		},
		{
			name:  "plan: an unsupported protocol on a running plugin stops it and keeps the spec of the process it runs",
			start: []rulePlugin{plug("beta", recRunning().with(starting))},
			event: plan("proto9"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(starting, desired("proto9"))},
				out:     "stop-incompatible err=" + unsupported + " compatible=false",
			},
		},
	})
}

// svcRecord is the service record planStartLocked creates for a plugin that had none.
func svcRecord(spec string, state ServiceState, slotValue slotState) recMod {
	return func(r *ruleRec) {
		r.Spec = spec
		r.State = state
		r.Slot = slotValue
	}
}

// recordFailure advances the status through the backoff ladder and, past the cutoff, to failed.
func TestRuleRecordFailure(t *testing.T) {
	status := func(failures int) RuntimeStatus {
		return RuntimeStatus{State: StateReady, ConsecutiveFailures: failures}
	}
	boom := errors.New("boom")
	cases := []struct {
		name      string
		failures  int
		err       error
		wantDelay time.Duration
		wantRetry bool
		wantState ServiceState
	}{
		{"the first failure waits one second", 0, boom, time.Second, true, StateBackoff},
		{"the second waits two", 1, boom, 2 * time.Second, true, StateBackoff},
		{"the third waits four", 2, boom, 4 * time.Second, true, StateBackoff},
		{"the fourth waits eight", 3, boom, 8 * time.Second, true, StateBackoff},
		{"the fifth is past the cutoff and the plugin stays failed", 4, boom, 0, false, StateFailed},
		{"a failure without an error keeps the last one", 0, nil, time.Second, true, StateBackoff},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := status(tc.failures)
			current.LastError = "earlier"

			delay, retry := recordFailure(&current, ruleNow, "exited", tc.err)

			if delay != tc.wantDelay || retry != tc.wantRetry || current.State != tc.wantState ||
				current.ConsecutiveFailures != tc.failures+1 || current.LastExit != "exited" {
				t.Fatalf("delay=%v retry=%v state=%v failures=%d exit=%q", delay, retry, current.State, current.ConsecutiveFailures, current.LastExit)
			}

			wantError := "earlier"

			if tc.err != nil {
				wantError = "boom"
			}

			if current.LastError != wantError {
				t.Fatalf("last error = %q, want %q", current.LastError, wantError)
			}

			if retry != (current.NextAttemptAt != nil) || (retry && !current.NextAttemptAt.Equal(ruleNow.Add(delay))) {
				t.Fatalf("next attempt = %v for delay %v", current.NextAttemptAt, delay)
			}
		})
	}
}

// transitionFailureLocked records the failure and, while a retry is allowed, schedules it.
func TestRuleTransitionFailure(t *testing.T) {
	fail := func(h *ruleHarness) ([]effect, string) {
		h.s.transitionFailureLocked(h.s.plugins["beta"], "beta", "start failed", errors.New("boom"))

		return nil, ""
	}
	failing := recStopped().with(inState(StateStarting), slot(slotHeld), op(OpStarting))
	backoff := failing.with(inState(StateBackoff), failures(1), nextAttempt("future"), withRetry())

	runTable(t, []ruleRow{
		{
			name:  "failure: a failed start waits in backoff and schedules its retry",
			start: []rulePlugin{plug("beta", failing)},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff}},
		},
		{
			name:  "failure: another failure replaces the retry in flight with one",
			start: []rulePlugin{plug("beta", failing.with(failures(1), withRetry()))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(failures(2))}},
		},
		{
			name:  "failure: the failure past the cutoff leaves the plugin failed and stops its retry",
			start: []rulePlugin{plug("beta", failing.with(failures(4), withRetry()))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": failing.with(inState(StateFailed), failures(5))}},
		},
		{
			name:  "failure: a plugin that is no longer enabled waits in backoff without a retry",
			start: []rulePlugin{plug("beta", failing.with(desired("off")))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(desired("off"), nextAttempt("future"), func(r *ruleRec) { r.Retry = false })}},
		},
		{
			name:  "failure: a plugin the desired set dropped waits in backoff without a retry",
			start: []rulePlugin{plug("beta", failing.with(desired("")))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(desired(""), func(r *ruleRec) { r.Retry = false })}},
		},
		{
			name:  "failure: after the lifetime context ended no retry is scheduled",
			start: []rulePlugin{plug("beta", failing)},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(func(r *ruleRec) { r.Retry = false })}},
		},
		{
			name:     "guard: failure: once shutdown started no retry is scheduled",
			guard:    "StopAll and the lifetime hook clear the desired set in the section that sets shuttingDown (supervisor.go:1141-1144, :448-450); with the desired set empty scheduleRetry returns at the next check anyway",
			shutting: true,
			start:    []rulePlugin{plug("beta", failing)},
			event:    fail,
			want:     ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(func(r *ruleRec) { r.Retry = false })}},
		},
	})
}

// observeProcessExit is the rule for a child that exits on its own: who owns the exit, how the failure is counted,
// what the plugin's pending start does and where the slot goes.
func TestRuleObserveProcessExit(t *testing.T) {
	exited := func(err error) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			h.closeExit("beta", err)
			h.s.observeProcessExit("beta", h.process["beta"])

			return ""
		}
	}
	crash := exited(errors.New("exit status 1"))
	crashed := recBackoff().with(nextAttempt("future"), withRetry())
	cutoff := failures(maxConsecutiveFailures - 1)
	failed := recStopped().with(inState(StateFailed), failures(maxConsecutiveFailures))
	// A startup that ran has dropped its ticket by the end of a drive row.
	restarted := recStopped().with(desired("v2"), svcSpec("v2"), slot(slotReservedByReconcile))
	healthyRunning := rulePlugin{id: "beta", rec: recRunning().with(failures(3)), healthy: true}

	runTable(t, []ruleRow{
		{
			name:  "exit: a ready process that crashes goes to backoff, keeps its slot and schedules its retry",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": crashed}},
		},
		{
			name:  "exit: a process that ran long enough starts its failure count over",
			start: []rulePlugin{healthyRunning},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": crashed}},
		},
		{
			name:  "exit: a process that did not run long enough adds to the failure count",
			start: []rulePlugin{plug("beta", recRunning().with(failures(3)))},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": crashed.with(failures(4))}},
		},
		{
			// Mirrors TestFailedPluginReleasesSlotToWaiter.
			name:  "exit: the failure past the cutoff leaves the plugin failed and gives its slot to the first waiter",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recRunning().with(cutoff))},
			drive: crash,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile)),
					"beta":  failed,
				},
				started: []string{"alpha:base"},
			},
		},
		{
			name:  "exit: a stop in flight owns the exit, the observer does nothing",
			start: []rulePlugin{plug("beta", recRunning().with(stopKindOf("release")))},
			drive: crash,
		},
		{
			name:  "exit: a child the record no longer owns is not observed",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: func(h *ruleHarness) string {
				other := newProcessExit()

				close(other.done)

				h.s.observeProcessExit("beta", &registeredProcess{id: 99, exit: other})

				return ""
			},
		},
		{
			name:  "exit: a plugin without a record is not observed",
			start: []rulePlugin{plug("alpha", recStopped())},
			drive: func(h *ruleHarness) string {
				other := newProcessExit()

				close(other.done)

				h.s.observeProcessExit("beta", &registeredProcess{id: 99, exit: other})

				return ""
			},
		},
		{
			// Mirrors TestExitedPluginWithChangedSpecKeepsItsSlotFromEarlierWaiter.
			name:  "exit: a changed desired spec restarts the plugin with the new one, the slot kept as a reservation",
			start: []rulePlugin{plug("beta", recRunning().with(desired("v2")))},
			drive: crash,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": restarted},
				started: []string{"beta:v2"},
			},
		},
		{
			name:  "exit: a changed desired spec restarts a plugin that crashed too many times, the failure count is not touched",
			start: []rulePlugin{plug("beta", recRunning().with(desired("v2"), cutoff))},
			drive: crash,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": restarted.with(cutoff)},
				started: []string{"beta:v2"},
			},
		},
		{
			name:  "exit: a changed desired spec is not restarted while a run is active, the exit is a failure",
			start: []rulePlugin{plug("beta", recRunning().with(desired("v2"), op(OpRestarting)))},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": crashed.with(desired("v2"), op(OpRestarting))}},
		},
		{
			name: "guard: exit: a child that exits while the status is stopped records no failure",
			guard: "a registered child with status Stopped and no stop is never written: every Stopped write either needs no process " +
				"(supervisor.go:1796, :2488, :2535), needs CapacityBlocked (:1489) or comes with a stop (:2565, :2586, :2609), and a stop " +
				"clears the process together with the stop (:2716); the exit branch is supervisor.go:2270",
			start: []rulePlugin{plug("beta", recRunning().with(inState(StateStopped)))},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped()}, free: freeSlots(1)},
		},
		{
			name:  "exit: a plugin that is no longer enabled records the failure and schedules no retry",
			start: []rulePlugin{plug("beta", recRunning().with(desired("off")))},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": crashed.with(desired("off"), func(r *ruleRec) { r.Retry = false })}},
		},
		{
			name:     "exit: once shutdown started the failure is recorded and no retry is scheduled",
			shutting: true,
			start:    []rulePlugin{plug("beta", recRunning().with(desired("")))},
			drive:    crash,
			want:     ruleWant{plugins: map[string]ruleRec{"beta": crashed.with(desired(""), func(r *ruleRec) { r.Retry = false })}},
		},
		{
			name:  "exit: a pending start for the same spec takes the exit as a restart, the failure is counted and the start runs",
			start: []rulePlugin{plug("beta", recRunning().with(pending("base", "current")))},
			drive: crash,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": crashed.with(nextAttempt(""), func(r *ruleRec) { r.Retry = false })},
				started: []string{"beta:base"},
			},
		},
		{
			// Mirrors TestCrashPastRetryCutoffDropsSameSpecPendingStart.
			name:  "exit: a pending start for the same spec is dropped when the failure is past the cutoff",
			start: []rulePlugin{plug("beta", recRunning().with(cutoff, pending("base", "current")))},
			drive: crash,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": failed}, free: freeSlots(1)},
		},
		{
			name:  "exit: a pending start for another spec survives the cutoff until the run in flight ends",
			start: []rulePlugin{plug("beta", recRunning().with(cutoff, desired("v2"), pending("v2", "current"), op(OpRestarting)))},
			drive: crash,
			want: ruleWant{plugins: map[string]ruleRec{
				"beta": failed.with(slot(slotHeld), desired("v2"), pending("v2", "current"), op(OpRestarting)),
			}},
		},
	})
}

// The retry callback has its own eligibility policy next to pendingStartEligibleLocked: it clears its own timer
// first, then asks the shared predicate, then looks at what the plugin is doing.
func TestRuleRetryCallback(t *testing.T) {
	wait := func(h *ruleHarness) string {
		h.awaitRetry("beta")

		return ""
	}
	// retryProcess: a process comes up only inside a run, and a run moves the generation, so the generation check
	// (supervisor.go:2429) drops the retry before it looks at the process. A retry scheduled inside that same run
	// comes only from failStart, after which the run launches nothing. The one reachable busy case is an unreaped keep
	// cleanup (supervisor.go:2048) followed by failStart, which is the keep-and-registered row above.
	const retryProcess = "a process comes up only inside a run, and a run moves the generation, which supervisor.go:2429 rejects first; the one " +
		"reachable busy case is an unreaped keep cleanup (supervisor.go:2048) followed by failStart, the keep-and-registered row"
	const retryStop = "every stop stops the retry timer when it starts (supervisor.go:2562, :2606); a retry scheduled during a stop comes from " +
		"failStart while the process is still registered, the keep-and-registered row"
	const retryState = "audit of every writer of status.State (supervisor.go:1489, 1517, 1796, 1821, 1826, 2102, 2256, 2323, 2331, 2488, 2535, 2565, " +
		"2586, 2609): each does not leave Backoff, stops the retry timer first (:2257, :2562, :2606, :2344) or runs inside a run, and a new run moves " +
		"the generation (newRunLocked, :800), which supervisor.go:2429 rejects before the state check at :2443"
	waiting := recBackoff().with(withRetry())
	spent := recBackoff()
	changeDesired := func(form string) func(h *ruleHarness) {
		return func(h *ruleHarness) {
			spec := ruleSpec("beta", form)
			h.s.plugins["beta"].desired = &spec
		}
	}

	runTable(t, []ruleRow{
		{
			name:       "retry: an idle plugin in backoff gets its startup",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting)},
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": spent}, started: []string{"beta:base"}},
		},
		{
			// Mirrors TestRetryCallbackAfterCancelDoesNothing.
			name:       "retry: a callback whose timer was stopped or replaced does nothing",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting)},
			prep:       func(h *ruleHarness) { h.s.plugins["beta"].service.retry = nil },
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": spent}},
		},
		{
			name:       "retry: a spec that changed since the timer was set is not started",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting)},
			prep:       changeDesired("v2"),
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": spent.with(desired("v2"))}},
		},
		{
			name:       "retry: a plugin with a run in flight is not started",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting.with(op(OpRestarting)))},
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": spent.with(op(OpRestarting))}},
		},
		{
			name:       "guard: retry: a process that came up since leaves the retry as a pending request",
			guard:      retryProcess,
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", recRunning().with(withRetry()))},
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": recRunning().with(pending("base+retry", "current"))}},
		},
		{
			name:       "retry: a stop in flight leaves the retry as a pending request",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting.with(proc("registered"), stopKindOf("keep")))},
			drive:      wait,
			want: ruleWant{plugins: map[string]ruleRec{
				"beta": spent.with(proc("registered"), stopKindOf("keep"), pending("base+retry", "current")),
			}},
		},
		{
			// Reachable today, so not a guard. cleanupFailedStart leaves (keep, registered) when the child outlives the stop
			// timeouts (supervisor.go:2655-2665, the finalizer ends the stop later); failStart then schedules the retry at the
			// current generation (:1974-1976); the mgmt work function is still inside the run (upload.go:176-180, update.go:282
			// rollbackUpdate) when the backoff fires, so the callback finds a run, a child and a stop together and drops the
			// retry. This pins today's behavior; TASK-48 owns the outcome (the plugin is left parked in Backoff).
			// Mutation eligible-op (no operation check) turns the drop into a pending start; the rows with no child cannot
			// tell, because trackDesiredStartupLocked refuses a run in flight too.
			name:       "retry: a plugin with a run in flight and a child still stopping drops the retry",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting.with(op(OpStarting), proc("registered"), stopKindOf("keep")))},
			drive:      wait,
			want: ruleWant{plugins: map[string]ruleRec{
				"beta": spent.with(op(OpStarting), proc("registered"), stopKindOf("keep")),
			}},
		},
		{
			name:       "retry: a retry whose transition generation moved on is dropped",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting.with(op(OpNone)))},
			prep: func(h *ruleHarness) {
				run := h.s.newRunLocked("beta", OpStarting, IntentRun)
				run.completed = true

				run.cancel()
				close(run.done)

				h.s.plugins["beta"].transition.run = run
			},
			drive: wait,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": spent}},
		},
		{
			name:       "guard: retry: a stop with no process in flight leaves the retry as a pending request",
			guard:      retryStop,
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting.with(stopKindOf("keep")))},
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": spent.with(stopKindOf("keep"), pending("base+retry", "current"))}},
		},
		{
			name:       "guard: retry: a plugin that is not in backoff is not started",
			guard:      retryState,
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", recStopped().with(withRetry()))},
			drive:      wait,
			want:       ruleWant{plugins: map[string]ruleRec{"beta": recStopped()}},
		},
		{
			// Mirrors TestRetryTimerStopsWhenLifetimeEnds.
			name:       "retry: after the lifetime context ended nothing is started",
			retryDelay: 5 * time.Millisecond,
			start:      []rulePlugin{plug("beta", waiting)},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			drive: wait,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": spent}},
		},
	})
}
