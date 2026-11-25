package backend

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// projectNow reads one plugin's state the way a concurrent caller would: under the mutex, at an unlock.
func (h *ruleHarness) projectNow(id string) ruleRec {
	h.s.mu.Lock()

	defer h.s.unlock()

	return h.projectLocked(id)
}

// eventually waits for a state, not for time: it yields until the condition holds or the row has waited long enough
// to call it a failure.
func (h *ruleHarness) eventually(what string, condition func(rec ruleRec) bool) {
	h.t.Helper()

	deadline := time.Now().Add(5 * time.Second)

	for !condition(h.projectNow("beta")) {
		if time.Now().After(deadline) {
			h.t.Fatalf("never reached: %s", what)
		}

		runtime.Gosched()
	}
}

func errorName(err error) string {
	switch {
	case err == nil:
		return "nil"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case strings.Contains(err.Error(), "did not exit"):
		return "not reaped"
	default:
		return "error: " + err.Error()
	}
}

// stopProcess is the one rule that stops a child. These rows are its pairs table: what a stop of each kind does to
// each process phase, and what a second stop does to a stop already in flight. Rows whose child exits in time run the
// stop to its end; the others look at the state a stop leaves in flight.
func TestRuleStopProcess(t *testing.T) {
	stopOf := func(kind stopKind, exits bool) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			if exits && h.exit["beta"] != nil {
				h.closeExit("beta", nil)
			}

			return errorName(h.s.stopProcess(context.Background(), "beta", kind))
		}
	}
	joinOf := func(kind stopKind) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			ctx, cancel := context.WithCancel(context.Background())

			cancel()

			return errorName(h.s.stopProcess(ctx, "beta", kind))
		}
	}
	running := recRunning().with(op(OpStarting))
	// stopped is what a stop that keeps nothing leaves of a plugin whose process is gone.
	stopped := recStopped().with(op(OpStarting), slot(slotHeld))
	launching := recStopped().with(op(OpStarting), inState(StateStarting), slot(slotHeld), proc("launching"))
	backoff := recBackoff().with(op(OpStarting), withRetry())
	waiter := plug("alpha", recBlocked())
	reservedWaiter := recBlocked().with(slot(slotReservedByReconcile))

	runTable(t, []ruleRow{
		{
			name:  "stop: a plugin without a service record has nothing to stop",
			start: []rulePlugin{plug("alpha", recStopped())},
			drive: stopOf(stopRelease, true),
			want:  ruleWant{out: "nil"},
		},
		{
			name:  "stop: release on a registered child that exits ends the stop, frees the slot and resets the status",
			start: []rulePlugin{plug("beta", running.with(failures(2)))},
			drive: stopOf(stopRelease, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil"},
		},
		{
			name:  "stop: release gives the slot it freed to the first waiter in the same section",
			start: []rulePlugin{waiter, plug("beta", running)},
			drive: stopOf(stopRelease, true),
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": reservedWaiter, "beta": recStopped().with(op(OpStarting))},
				started: []string{"alpha:base"},
				out:     "nil",
			},
		},
		{
			name:  "stop: restart on a registered child keeps the slot, claimed, and resets the status",
			start: []rulePlugin{plug("beta", running.with(failures(2)))},
			drive: stopOf(stopRestart, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": stopped}, out: "nil"},
		},
		{
			name:  "stop: keep on a registered child leaves status and slot as they were",
			start: []rulePlugin{plug("beta", running.with(inState(StateStarting), failures(2)))},
			drive: stopOf(stopKeep, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": running.with(inState(StateStarting), proc(""), failures(2))}, out: "nil"},
		},
		{
			name:  "stop: release on a child that is not registered yet stops it the same way",
			start: []rulePlugin{plug("beta", running.with(proc("started"), inState(StateStarting)))},
			drive: stopOf(stopRelease, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil"},
		},
		{
			name:  "guard: stop: restart on a child that is not registered yet keeps the slot",
			guard: "a restart stop comes only from startReplace, which needs a registered child (supervisor.go:1777-1781)",
			start: []rulePlugin{plug("beta", running.with(proc("started"), inState(StateStarting)))},
			drive: stopOf(stopRestart, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": stopped}, out: "nil"},
		},
		{
			name:  "guard: stop: keep on a child that is not registered yet leaves the starting status alone",
			guard: "a keep stop comes only from cleanupFailedStart, which runs after registration (supervisor.go:1972-1983); a started-only child is stopped only by reapUnregisteredProcess or StopAll, both with release (process.go:155)",
			start: []rulePlugin{plug("beta", running.with(proc("started"), inState(StateStarting)))},
			drive: stopOf(stopKeep, true),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": running.with(proc(""), inState(StateStarting))}, out: "nil"},
		},
		{
			name:  "stop: release on a plugin without a process stops its retry, resets the status and frees the slot",
			start: []rulePlugin{plug("beta", backoff)},
			drive: stopOf(stopRelease, false),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil"},
		},
		{
			name:  "stop: restart on a plugin without a process stops its retry and keeps the slot",
			start: []rulePlugin{plug("beta", backoff)},
			drive: stopOf(stopRestart, false),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": stopped}, out: "nil"},
		},
		{
			name:  "stop: keep on a plugin without a process stops its retry and keeps the status",
			start: []rulePlugin{plug("beta", backoff)},
			drive: stopOf(stopKeep, false),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": backoff.with(func(r *ruleRec) { r.Retry = false })}, out: "nil"},
		},
		{
			name:  "stop: a child that does not exit leaves the stop in flight with the slot still held, then the finalizer ends it",
			start: []rulePlugin{plug("beta", running)},
			drive: func(h *ruleHarness) string {
				err := errorName(h.s.stopProcess(context.Background(), "beta", stopRelease))
				inFlight := h.projectNow("beta")

				h.closeExit("beta", nil)
				h.waitForStop("beta")

				return fmt.Sprintf("%s in flight: stop=%s proc=%s slot=%v state=%s", err, inFlight.Stop, inFlight.Proc, inFlight.Slot, inFlight.State)
			},
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))},
				free:    freeSlots(1),
				out:     "not reaped in flight: stop=release proc=registered slot=held state=stopped",
			},
		},
		{
			name:  "stop: a second stop of a stronger kind joins the one in flight and raises its kind",
			start: []rulePlugin{plug("beta", running.with(stopKindOf("keep")))},
			drive: joinOf(stopRelease),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting), slot(slotHeld), proc("registered"), stopKindOf("release"))},
				out:     "canceled",
			},
		},
		{
			name:  "stop: a restart joining a keep stop raises it to restart and resets the status",
			start: []rulePlugin{plug("beta", running.with(stopKindOf("keep"), failures(2)))},
			drive: joinOf(stopRestart),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting), slot(slotHeld), proc("registered"), stopKindOf("restart"))},
				out:     "canceled",
			},
		},
		{
			name:  "stop: a keep joining a release stop changes nothing",
			start: []rulePlugin{plug("beta", running.with(stopKindOf("release"), inState(StateStopped)))},
			drive: joinOf(stopKeep),
			want:  ruleWant{out: "canceled"},
		},
		{
			// Mirrors TestStopJoinKeepsTheStrongerKind.
			name:  "stop: a restart joining a release stop does not lower it",
			start: []rulePlugin{plug("beta", running.with(stopKindOf("release"), inState(StateStopped)))},
			drive: joinOf(stopRestart),
			want:  ruleWant{out: "canceled"},
		},
		{
			name:  "stop: a release joining a release stop changes nothing",
			start: []rulePlugin{plug("beta", running.with(stopKindOf("release"), inState(StateStopped)))},
			drive: joinOf(stopRelease),
			want:  ruleWant{out: "canceled"},
		},
		{
			name:  "stop: a launch in flight is waited for, release resets the status first",
			start: []rulePlugin{plug("beta", launching.with(failures(2)))},
			drive: joinOf(stopRelease),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": launching.with(inState(StateStopped))},
				out:     "canceled",
			},
		},
		{
			name:  "stop: a launch in flight is waited for, keep leaves status and slot alone",
			start: []rulePlugin{plug("beta", launching.with(failures(2)))},
			drive: joinOf(stopKeep),
			want:  ruleWant{out: "canceled"},
		},
		{
			name:  "stop: a launch in flight is waited for, restart resets the status and keeps the slot",
			start: []rulePlugin{plug("beta", launching.with(failures(2)))},
			drive: joinOf(stopRestart),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": launching.with(inState(StateStopped))}, out: "canceled"},
		},
		{
			name:  "stop: once the launch is over the stop proceeds and ends as a stop with no process",
			start: []rulePlugin{plug("beta", launching)},
			drive: func(h *ruleHarness) string {
				done := make(chan error, 1)

				go func() { done <- h.s.stopProcess(context.Background(), "beta", stopRelease) }()

				h.eventually("the stop reset the status and waits for the launch", func(rec ruleRec) bool { return rec.State == StateStopped })

				h.s.mu.Lock()

				record := h.s.serviceRecordLocked("beta")
				launch := record.service.launching()
				record.service.proc = nil

				close(launch.done)
				h.s.unlock()

				return errorName(<-done)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil"},
		},
	})
}

// finishStop completes a stop only for the stop, the process and the record that started it.
func TestRuleFinishStop(t *testing.T) {
	finish := func(stopErr error, change func(h *ruleHarness, record *pluginRecord, process **registeredProcess, stop **stopState)) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			record := h.s.plugins["beta"]
			process := h.process["beta"]
			stop := h.stop["beta"]

			if change != nil {
				change(h, record, &process, &stop)
			}

			err := h.s.finishStop("beta", record, process, RuntimePaths{}, stop, stopErr)

			select {
			case <-h.stop["beta"].done:
				return fmt.Sprintf("%s done", errorName(err))
			default:
				return fmt.Sprintf("%s open", errorName(err))
			}
		}
	}
	stopping := func(kind string) ruleRec {
		return recRunning().with(op(OpStarting), inState(StateStopped), stopKindOf(kind))
	}
	boom := errors.New("boom")

	runTable(t, []ruleRow{
		{
			name:  "finish: a release stop ends, drops the child, frees the slot and wakes its waiters",
			start: []rulePlugin{plug("beta", stopping("release"))},
			drive: finish(nil, nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil done"},
		},
		{
			name:  "finish: a restart stop ends and keeps the slot, claimed",
			start: []rulePlugin{plug("beta", stopping("restart"))},
			drive: finish(nil, nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting), slot(slotHeld))}, out: "nil done"},
		},
		{
			name:  "finish: a keep stop ends and keeps the slot and the status",
			start: []rulePlugin{plug("beta", stopping("keep"))},
			drive: finish(nil, nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": stopping("keep").with(proc(""), stopKindOf(""))}, out: "nil done"},
		},
		{
			name:  "finish: a stop that ended with an error reports it and keeps it for the plugin",
			start: []rulePlugin{plug("beta", stopping("release"))},
			drive: finish(boom, nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "error: boom done"},
		},
		{
			name:  "finish: the freed slot goes to the first waiter in the same section",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", stopping("release"))},
			drive: finish(nil, nil),
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": recBlocked().with(slot(slotReservedByReconcile)), "beta": recStopped().with(op(OpStarting))},
				started: []string{"alpha:base"},
				out:     "nil done",
			},
		},
		{
			name:  "finish: a pending start waits for the stop and then takes the slot the stop freed",
			start: []rulePlugin{plug("beta", recRunning().with(inState(StateStopped), stopKindOf("release"), desired("v2"), pending("v2", "current")))},
			drive: finish(nil, nil),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("v2"), svcSpec("v2"), slot(slotReservedByReconcile))},
				started: []string{"beta:v2"},
				out:     "nil done",
			},
		},
		{
			name:  "finish: a pending start runs on the slot a restart stop kept",
			start: []rulePlugin{plug("beta", recRunning().with(inState(StateStopped), stopKindOf("restart"), desired("v2"), pending("v2", "current")))},
			drive: finish(nil, nil),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("v2"), svcSpec("v2"), slot(slotReservedByReconcile))},
				started: []string{"beta:v2"},
				out:     "nil done",
			},
		},
		{
			name:  "finish: a stop that is no longer the record's stop changes nothing",
			start: []rulePlugin{plug("beta", stopping("release"))},
			drive: finish(nil, func(_ *ruleHarness, _ *pluginRecord, _ **registeredProcess, stop **stopState) {
				*stop = &stopState{done: make(chan struct{}), kind: stopRelease}
			}),
			want: ruleWant{out: "nil open"},
		},
		{
			name:  "finish: a process the record does not own changes nothing",
			start: []rulePlugin{plug("beta", stopping("release"))},
			drive: finish(nil, func(_ *ruleHarness, _ *pluginRecord, process **registeredProcess, _ **stopState) {
				*process = &registeredProcess{id: 99, exit: newProcessExit()}
			}),
			want: ruleWant{out: "nil open"},
		},
		{
			name:  "finish: a record the plugin no longer has changes nothing",
			start: []rulePlugin{plug("beta", stopping("release"))},
			drive: finish(nil, func(_ *ruleHarness, record *pluginRecord, _ **registeredProcess, _ **stopState) {
				_ = record
			}),
			want: ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(op(OpStarting))}, free: freeSlots(1), out: "nil done"},
		},
	})
}

// StopAll and the lifetime hook are the shutdown rule: the desired set is cleared in the section that sets
// shuttingDown, retry timers and pending starts go, runs are canceled, then every service is stopped and released.
func TestRuleShutdown(t *testing.T) {
	stopAll := func(h *ruleHarness) string {
		for id := range h.exit {
			h.closeExit(id, nil)
		}

		err := h.s.StopAll(context.Background())

		return fmt.Sprintf("%s shutting=%v", errorName(err), h.s.shuttingDown)
	}
	released := func(rec ruleRec) ruleRec {
		return recStopped().with(desired(""), op(rec.Op), intent(rec.Intent))
	}

	runTable(t, []ruleRow{
		{
			name:  "shutdown: a running plugin is stopped, loses its desired spec and its slot",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: stopAll,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": released(recRunning())}, free: freeSlots(1), out: "nil shutting=true"},
		},
		{
			name:  "shutdown: a waiter is stopped with the rest and is not started with the slot the stop frees",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recRunning())},
			drive: stopAll,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": recStopped().with(desired("")), "beta": released(recRunning())},
				free:    freeSlots(1),
				out:     "nil shutting=true",
			},
		},
		{
			name:  "shutdown: retry timers and pending starts are dropped and the plugin is released",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry(), pending("base", "current")))},
			drive: stopAll,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": released(recBackoff())}, free: freeSlots(1), out: "nil shutting=true"},
		},
		{
			name:  "shutdown: a plugin without a service record is only cleared from the desired set",
			start: []rulePlugin{plug("beta", recBlocked().with(noService()))},
			drive: stopAll,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "run"}}, out: "nil shutting=true"},
		},
		{
			name:  "shutdown: a run in flight is canceled and stays the plugin's run until its owner ends it",
			start: []rulePlugin{plug("beta", recRunning().with(op(OpStarting)))},
			drive: func(h *ruleHarness) string {
				out := stopAll(h)

				return fmt.Sprintf("%s run canceled=%v completed=%v", out, h.run["beta"].ctx.Err() != nil, h.run["beta"].completed)
			},
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": released(recRunning().with(op(OpStarting)))},
				free:    freeSlots(1),
				out:     "nil shutting=true run canceled=true completed=false",
			},
		},
		{
			name:  "shutdown: a child that does not exit is reported and its stop finishes when it does",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: func(h *ruleHarness) string {
				err := errorName(h.s.StopAll(context.Background()))

				h.closeExit("beta", nil)
				h.waitForStop("beta")

				return err
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": released(recRunning())}, free: freeSlots(1), out: "not reaped"},
		},
		{
			name:  "shutdown: the lifetime hook clears the desired set and the retry timers",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry(), pending("base", "current")))},
			drive: func(h *ruleHarness) string {
				h.cancelLifetime()
				h.eventually("the lifetime hook ran", func(ruleRec) bool {
					h.s.mu.Lock()

					defer h.s.unlock()

					return h.s.shuttingDown
				})

				return "hook ran"
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired(""))}, out: "hook ran"},
		},
	})
}

// The lifecycle wrappers hand a run's token to the rules that begin and end it.
func TestRuleLifecycle(t *testing.T) {
	token := func(h *ruleHarness) *lifecycleToken { return &lifecycleToken{run: h.run["beta"]} }
	running := recBackoff().with(op(OpStarting))

	runTable(t, []ruleRow{
		{
			name:  "lifecycle: a desired startup for the spec the plugin wants begins a start and spends its ticket",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup()))},
			drive: func(h *ruleHarness) string {
				outcome := h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base"))

				return fmt.Sprintf("run=%v conflict=%v joined=%v", outcome.run != nil, outcome.conflict, outcome.joined)
			},
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(op(OpStarting))},
				out:     "run=true conflict=false joined=false",
			},
		},
		{
			name:  "lifecycle: a desired startup for a spec the plugin no longer wants conflicts and leaves the ticket",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup(), desired("v2")))},
			drive: func(h *ruleHarness) string {
				outcome := h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base"))

				return fmt.Sprintf("run=%v conflict=%v", outcome.run != nil, outcome.conflict)
			},
			want: ruleWant{out: "run=false conflict=true"},
		},
		{
			name:  "lifecycle: a desired startup for a disabled plugin conflicts",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup(), desired("off")))},
			drive: func(h *ruleHarness) string {
				return fmt.Sprint("conflict=", h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base")).conflict)
			},
			want: ruleWant{out: "conflict=true"},
		},
		{
			name:  "lifecycle: a desired startup for a plugin whose intent is stop conflicts",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup(), intent("stop")))},
			drive: func(h *ruleHarness) string {
				return fmt.Sprint("conflict=", h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base")).conflict)
			},
			want: ruleWant{out: "conflict=true"},
		},
		{
			name:  "lifecycle: a desired startup for a plugin with a run in flight conflicts",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup(), op(OpRestarting)))},
			drive: func(h *ruleHarness) string {
				return fmt.Sprint("conflict=", h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base")).conflict)
			},
			want: ruleWant{out: "conflict=true"},
		},
		{
			name:  "lifecycle: a desired startup for a plugin the desired set dropped conflicts",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup(), desired("")))},
			drive: func(h *ruleHarness) string {
				return fmt.Sprint("conflict=", h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base")).conflict)
			},
			want: ruleWant{out: "conflict=true"},
		},
		{
			name:  "lifecycle: a desired startup after the lifetime context ended conflicts",
			start: []rulePlugin{plug("beta", recBackoff().with(withStartup()))},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			drive: func(h *ruleHarness) string {
				return fmt.Sprint("conflict=", h.s.beginDesiredStartupOutcome(ruleSpec("beta", "base")).conflict)
			},
			want: ruleWant{out: "conflict=true"},
		},
		{
			name:  "lifecycle: finishing a start commits the run and starts the pending start in the same section",
			start: []rulePlugin{plug("beta", running.with(pending("base", "current")))},
			drive: func(h *ruleHarness) string {
				h.s.finishLifecycle(token(h), OpStarting)

				return ""
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(nextAttempt(""))}, started: []string{"beta:base"}},
		},
		{
			name:  "lifecycle: a failed start gives the intent back",
			start: []rulePlugin{plug("beta", running.with(prior("stop")))},
			drive: func(h *ruleHarness) string {
				h.s.failLifecycle(token(h), errors.New("boom"))

				return ""
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(intent("stop"), prior("stop"))}},
		},
		{
			name:  "lifecycle: a forced stop leaves the plugin stopped whatever it was doing",
			start: []rulePlugin{plug("beta", running.with(prior("run"), target("run")))},
			drive: func(h *ruleHarness) string {
				h.s.failLifecycle(token(h), fmt.Errorf("%w: boom", ErrForceStopTerminal))

				return ""
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(intent("stop"))}},
		},
		{
			name:  "lifecycle: no token, nothing to finish or fail",
			start: []rulePlugin{plug("beta", running)},
			drive: func(h *ruleHarness) string {
				h.s.failLifecycle(nil, errors.New("boom"))

				return fmt.Sprint(h.s.finishLifecycle(nil, OpStarting) == nil)
			},
			want: ruleWant{out: "true"},
		},
		{
			name:  "lifecycle: a plugin whose intent is stop blocks traffic",
			start: []rulePlugin{plug("beta", recBackoff().with(intent("stop")))},
			drive: func(h *ruleHarness) string { return fmt.Sprint(h.s.blocksTraffic("beta")) },
			want:  ruleWant{out: "true"},
		},
		{
			name:  "lifecycle: a plugin with an exclusive operation blocks traffic",
			start: []rulePlugin{plug("beta", recBackoff().with(op(OpUpdating)))},
			drive: func(h *ruleHarness) string { return fmt.Sprint(h.s.blocksTraffic("beta")) },
			want:  ruleWant{out: "true"},
		},
		{
			name:  "lifecycle: a plugin that only runs does not block traffic",
			start: []rulePlugin{plug("beta", recBackoff())},
			drive: func(h *ruleHarness) string { return fmt.Sprint(h.s.blocksTraffic("beta")) },
			want:  ruleWant{out: "false"},
		},
		{
			name:  "lifecycle: a plugin the supervisor never saw does not block traffic",
			start: []rulePlugin{plug("alpha", recBackoff())},
			drive: func(h *ruleHarness) string { return fmt.Sprint(h.s.blocksTraffic("beta")) },
			want:  ruleWant{out: "false"},
		},
	})
}

// The stop × proc pairs table. A plugin has a stop kind (none, keep, restart, release) and a process phase (none,
// launching, started, registered), and a slot; this is the sixteen pairs for each slot.
//
// Stop + launching is forbidden until TASK-48; the spec's target model allows it. Today the checker rejects it (I12,
// enforced) because production never builds it: stopProcess waits for a launch before it creates a stop (TestRuleStopProcess,
// "a launch in flight is waited for"), and beginServiceLaunch refuses to launch while a stop is in flight (the launch
// rows below). TASK-48 makes the pair representable and relaxes I12; this table and the launch rows then change.
//
// The slot changes the answer only for a plugin with a process phase: without a slot (I2) or with only Reconcile's
// reservation (I3) a child has no right to be there, whatever the stop is. Both columns also keep I12.
//
// Every allowed pair with a held slot has the production route that reaches it, named by rule and test, or is marked
// as having no route. The two no-route pairs are a started-only child under a keep or a restart stop: a restart comes
// only from startReplace, which needs a registered child (supervisor.go:1777-1781); a keep comes only from
// cleanupFailedStart, which runs after registration (supervisor.go:1972-1983); a started-only child is stopped only
// by reapUnregisteredProcess or StopAll, both with release (process.go:155).
func TestRuleStopProcPairs(t *testing.T) {
	const noRoute = "no route"

	type pair struct{ stop, proc string }

	routes := map[pair]string{
		{"", ""}:                  "start: planStartLocked, TestRulePlanStart \"plan: a stopped plugin without a slot takes a free one and proceeds\"",
		{"", "launching"}:         "beginServiceLaunch, below \"launch: a start with no stop in flight begins its launch\"",
		{"", "started"}:           "attachStartedProcess, TestRuleAttachStartedProcess \"attach: the child takes the launch's place and the launch is ended\"",
		{"", "registered"}:        "registerServiceProcess, TestRuleRegisterServiceProcess \"register: a started child of the current run is registered\"",
		{"keep", ""}:              "stopProcess keep on a record without a process, TestRuleStopProcess \"stop: keep on a plugin without a process stops its retry and keeps the status\"",
		{"keep", "started"}:       noRoute,
		{"keep", "registered"}:    "cleanupFailedStart, TestRuleCleanupFailedStart \"cleanup: a child that does not exit leaves the keep stop in flight\"",
		{"restart", ""}:           "stopProcess restart after the child exited between the plan and the stop, TestRuleStopProcess \"stop: restart on a plugin without a process stops its retry and keeps the slot\"",
		{"restart", "started"}:    noRoute,
		{"restart", "registered"}: "startReplace, TestRuleStopProcess \"stop: restart on a registered child keeps the slot, claimed, and resets the status\"",
		{"release", ""}:           "stopService or StopAll on a record without a process, TestRuleStopProcess \"stop: release on a plugin without a process stops its retry, resets the status and frees the slot\"",
		{"release", "started"}:    "reapUnregisteredProcess or StopAll, TestRuleReapUnregisteredProcess \"reap: a started child that was never registered is stopped and released\"",
		{"release", "registered"}: "stopService, TestRuleStopProcess \"stop: release on a registered child that exits ends the stop, frees the slot and resets the status\"",
	}
	// wantViolations is the verdict of the checker: I12 for a stop with a launch in flight, and I2 or I3 for a child
	// the slot does not allow.
	wantViolations := func(slotValue slotState, kind, phase string) []invariantID {
		var want []invariantID

		if phase != "" && slotValue == slotNone {
			want = append(want, invI2)
		}

		if phase != "" && slotValue == slotReservedByReconcile {
			want = append(want, invI3)
		}

		if kind != "" && phase == "launching" {
			want = append(want, invI12)
		}

		slices.Sort(want)

		return want
	}

	for _, slotValue := range []slotState{slotHeld, slotNone, slotReservedByReconcile} {
		for _, kind := range []string{"", "keep", "restart", "release"} {
			for _, phase := range []string{"", "launching", "started", "registered"} {
				name := fmt.Sprintf("slot=%v stop=%q proc=%q", slotValue, kind, phase)

				t.Run(name, func(t *testing.T) {
					harness := newRuleHarness(t, 1, false)
					seed := recRunning().with(op(OpStarting), inState(StateStarting), proc(phase), stopKindOf(kind), slot(slotValue))

					harness.s.mu.Lock()
					harness.seedLocked([]rulePlugin{plug("beta", seed)}, time.Hour)

					violations := harness.s.checkInvariantsLocked()

					harness.s.mu.Unlock()

					var got []invariantID

					for _, violation := range violations {
						got = append(got, violation.ID)
					}

					slices.Sort(got)

					if want := wantViolations(slotValue, kind, phase); !slices.Equal(got, want) {
						t.Fatalf("violations = %v, want %v", got, want)
					}

					if slotValue != slotHeld || (phase == "launching" && kind != "") {
						return
					}

					if route := routes[pair{kind, phase}]; route == "" {
						t.Fatalf("an allowed pair needs the production route that reaches it, or %q", noRoute)
					}
				})
			}
		}
	}

	for _, entry := range []struct {
		pair  pair
		route string
	}{{pair{"keep", "started"}, noRoute}, {pair{"restart", "started"}, noRoute}} {
		if routes[entry.pair] != entry.route {
			t.Fatalf("pair %v: the two no-route pairs are keep and restart with a started child", entry.pair)
		}
	}

	launch := func(h *ruleHarness) string {
		_, admitted := h.s.beginServiceLaunch(h.run["beta"], h.s.plugins["beta"])
		inFlight := h.projectNow("beta")

		return fmt.Sprintf("admitted=%v proc=%q stop=%q", admitted, inFlight.Proc, inFlight.Stop)
	}
	idle := recStopped().with(op(OpStarting), inState(StateStarting), slot(slotHeld))

	runTable(t, []ruleRow{
		{
			name:  "launch: a start with no stop in flight begins its launch",
			start: []rulePlugin{plug("beta", idle)},
			drive: launch,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": idle.with(proc("launching"))}, out: `admitted=true proc="launching" stop=""`},
		},
		{
			// Mirrors TestBeginServiceLaunchRefusesWhileStopping.
			name:  "launch: a keep stop in flight refuses the launch",
			start: []rulePlugin{plug("beta", idle.with(stopKindOf("keep")))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="" stop="keep"`},
		},
		{
			name:  "launch: a restart stop in flight refuses the launch",
			start: []rulePlugin{plug("beta", idle.with(stopKindOf("restart")))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="" stop="restart"`},
		},
		{
			name:  "launch: a release stop in flight refuses the launch",
			start: []rulePlugin{plug("beta", idle.with(stopKindOf("release")))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="" stop="release"`},
		},
		{
			name:  "launch: a plugin without a slot refuses the launch",
			start: []rulePlugin{plug("beta", idle.with(slot(slotNone), inState(StateCapacityBlocked)))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="" stop=""`},
		},
		{
			name:  "launch: a process already present refuses a second launch",
			start: []rulePlugin{plug("beta", idle.with(proc("started")))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="started" stop=""`},
		},
		{
			name: "guard: launch: once shutdown started the launch is refused",
			guard: "StopAll cancels every current run in the section that sets shuttingDown (supervisor.go:1148-1152) and the lifetime " +
				"hook cancels the lifetime context every run derives from (supervisor.go:801), so run.ctx.Err() refuses first (supervisor.go:1998)",
			shutting: true,
			start:    []rulePlugin{plug("beta", idle)},
			drive:    launch,
			want:     ruleWant{out: `admitted=false proc="" stop=""`},
		},
		{
			name:  "launch: a run that is no longer current refuses the launch",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry()))},
			drive: launch,
			want:  ruleWant{out: `admitted=false proc="" stop=""`},
		},
	})
}
