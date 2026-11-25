package backend

import (
	"context"
	"fmt"
	"testing"

	"github.com/coder/websocket"
)

// ruleSocket is a tracked socket that only has to exist: the rules never close it.
type ruleSocket struct{}

func (ruleSocket) Close(websocket.StatusCode, string) error { return nil }

// A pending start is cleared when the desired spec it was recorded for goes away or changes.
func TestRuleSetDesired(t *testing.T) {
	set := func(spec *ServiceSpec) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			h.s.setDesiredLocked("beta", spec)

			return nil, ""
		}
	}
	form := func(name string) *ServiceSpec {
		spec := ruleSpec("beta", name)

		return &spec
	}
	waiting := recBackoff().with(pending("v2", "current"), desired("v2"))

	runTable(t, []ruleRow{
		{
			name:  "desired: a spec for an unknown plugin creates its record",
			start: []rulePlugin{plug("alpha", recStopped())},
			event: set(form("base")),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Desired: "base"}}},
		},
		{
			name:  "desired: the spec a pending start was recorded for keeps it",
			start: []rulePlugin{plug("beta", waiting)},
			event: set(form("v2")),
		},
		{
			name:  "desired: another spec drops the pending start recorded for the old one",
			start: []rulePlugin{plug("beta", waiting)},
			event: set(form("v3")),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired("v3"))}},
		},
		{
			name:  "desired: no pending start, the spec is only stored",
			start: []rulePlugin{plug("beta", recBackoff())},
			event: set(form("v2")),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired("v2"))}},
		},
		{
			name:  "desired: removing the spec drops the pending start and keeps the record while it has a service",
			start: []rulePlugin{plug("beta", waiting)},
			event: set(nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired(""))}},
		},
		{
			name:  "desired: removing the spec of a plugin with nothing else deletes its record",
			start: []rulePlugin{plug("beta", ruleRec{Desired: "base"})},
			event: set(nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {}}},
		},
		{
			name:  "desired: removing the spec keeps the record while a run or a transition owns it",
			start: []rulePlugin{plug("beta", ruleRec{Desired: "base"}.with(intent("run")))},
			event: func(h *ruleHarness) ([]effect, string) {
				h.s.setDesiredLocked("beta", nil)

				return nil, fmt.Sprintf("kept=%v", h.s.plugins["beta"] != nil)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": ruleRec{}.with(intent("run"))}, out: "kept=true"},
		},
		{
			name:  "desired: removing the spec keeps the record while a socket is tracked on it",
			start: []rulePlugin{plug("beta", ruleRec{Desired: "base"})},
			event: func(h *ruleHarness) ([]effect, string) {
				h.s.plugins["beta"].sockets = map[socketCloser]struct{}{ruleSocket{}: {}}

				h.s.setDesiredLocked("beta", nil)

				return nil, fmt.Sprintf("kept=%v", h.s.plugins["beta"] != nil)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": {}}, out: "kept=true"},
		},
		{
			name:  "desired: removing the spec keeps the record while only its service is left",
			start: []rulePlugin{plug("beta", recStopped().with(intent("")))},
			event: func(h *ruleHarness) ([]effect, string) {
				h.s.setDesiredLocked("beta", nil)

				return nil, fmt.Sprintf("kept=%v", h.s.plugins["beta"] != nil)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(intent(""), desired(""))}, out: "kept=true"},
		},
		{
			name:  "desired: stopping a retry timer keeps a record that still has a desired spec",
			start: []rulePlugin{plug("beta", ruleRec{Desired: "base"})},
			event: func(h *ruleHarness) ([]effect, string) {
				h.s.stopRetryTimerLocked("beta")

				return nil, fmt.Sprintf("kept=%v", h.s.plugins["beta"] != nil)
			},
			want: ruleWant{plugins: map[string]ruleRec{"beta": {Desired: "base"}}, out: "kept=true"},
		},
		{
			name:  "desired: removing the spec of an unknown plugin does nothing",
			start: []rulePlugin{plug("alpha", recStopped())},
			event: set(nil),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {}}},
		},
	})
}

// trackDesiredStartupLocked decides, for a spec the desired set still wants, between starting it now, recording a
// pending start behind what is busy, and doing nothing.
func TestRuleTrackDesiredStartup(t *testing.T) {
	track := func(form string) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			return h.s.trackDesiredStartupLocked(ruleSpec("beta", form)), ""
		}
	}
	idleBackoff := recBackoff()
	const noLaunchIdle = "a launch begins only for a current run (supervisor.go:1998), a current run means the operation is not OpNone, and this rule returns at its operation check first (:1064)"

	runTable(t, []ruleRow{
		{
			name:  "startup: an idle plugin gets a startup effect and a ticket",
			start: []rulePlugin{plug("beta", idleBackoff)},
			event: track("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": idleBackoff.with(withStartup())},
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "startup: a startup already queued is not queued twice",
			start: []rulePlugin{plug("beta", idleBackoff.with(withStartup()))},
			event: track("base"),
		},
		{
			name:  "startup: a stop in flight records a pending start for the current generation",
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotHeld), stopKindOf("release")))},
			event: track("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(slot(slotHeld), stopKindOf("release"), pending("base", "current"))},
			},
		},
		{
			name:  "startup: a pending start replaces an older one and moves to the current generation",
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotHeld), stopKindOf("release"), pending("v2", "older")))},
			event: track("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(slot(slotHeld), stopKindOf("release"), pending("base", "current"))},
			},
		},
		{
			name:  "startup: recording a pending start stops the retry timer",
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotHeld), stopKindOf("release"), withRetry()))},
			event: track("base"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(slot(slotHeld), stopKindOf("release"), pending("base", "current"))},
			},
		},
		{
			name:  "startup: a running process of the same spec records a pending start",
			start: []rulePlugin{plug("beta", recRunning())},
			event: track("base"),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recRunning().with(pending("base", "current"))}},
		},
		{
			name:  "startup: a running process of another spec is replaced by a startup, not by a pending start",
			start: []rulePlugin{plug("beta", recRunning().with(desired("v2")))},
			event: track("v2"),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(desired("v2"), withStartup())},
				effects: []string{"start beta:v2"},
			},
		},
		{
			name:  "guard: startup: a launch in flight records a pending start",
			guard: noLaunchIdle,
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotHeld), proc("launching")))},
			event: track("base"),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped().with(slot(slotHeld), proc("launching"), pending("base", "current"))}},
		},
		{
			name:  "startup: a spec that is no longer wanted starts nothing",
			start: []rulePlugin{plug("beta", idleBackoff.with(desired("v2")))},
			event: track("base"),
		},
		{
			name:  "startup: a disabled plugin starts nothing",
			start: []rulePlugin{plug("beta", idleBackoff.with(desired("off")))},
			event: track("base"),
		},
		{
			name:  "startup: a plugin the desired set dropped starts nothing",
			start: []rulePlugin{plug("beta", idleBackoff.with(desired("")))},
			event: track("base"),
		},
		{
			name:  "startup: a plugin without a service starts nothing",
			start: []rulePlugin{plug("beta", idleBackoff.with(noService(), desired("base")))},
			event: track("base"),
		},
		{
			name:  "startup: a plugin whose intent is stop starts nothing",
			start: []rulePlugin{plug("beta", idleBackoff.with(intent("stop")))},
			event: track("base"),
		},
		{
			name:  "startup: a plugin with a run in flight starts nothing, the run settles its own pending start",
			start: []rulePlugin{plug("beta", idleBackoff.with(op(OpStarting)))},
			event: track("base"),
		},
		{
			name:     "guard: startup: once shutdown started nothing starts",
			guard:    "StopAll and the lifetime hook clear the desired set in the section that sets shuttingDown (supervisor.go:1141-1144, :448-450), so a spec is no longer wanted then",
			shutting: true,
			start:    []rulePlugin{plug("beta", idleBackoff)},
			event:    track("base"),
		},
		{
			name:  "guard: startup: with no startup function nothing starts",
			guard: "NewRuntime sets startDesired when it builds the supervisor (runtime.go:115)",
			start: []rulePlugin{plug("beta", idleBackoff)},
			prep:  func(h *ruleHarness) { h.s.startDesired = nil },
			event: track("base"),
		},
		{
			name:  "startup: after the lifetime context ended nothing starts, before its hook cleared the desired set",
			start: []rulePlugin{plug("beta", idleBackoff)},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			event: track("base"),
		},
	})
}

// The one place that decides whether a pending start may still run.
func TestRulePendingStartEligible(t *testing.T) {
	eligible := func(older bool) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			generation := h.s.transitionGenerationLocked("beta")

			if older {
				generation--
			}

			return nil, fmt.Sprint(h.s.pendingStartEligibleLocked("beta", ruleSpec("beta", "v2"), generation))
		}
	}
	wanted := recBackoff().with(desired("v2"))

	runTable(t, []ruleRow{
		{
			name:  "eligible: the spec is wanted, the intent is run, no run is active, the generation is current",
			start: []rulePlugin{plug("beta", wanted)},
			event: eligible(false),
			want:  ruleWant{out: "true"},
		},
		{
			name:  "eligible: not after the transition generation moved on",
			start: []rulePlugin{plug("beta", wanted)},
			event: eligible(true),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not while a run is active",
			start: []rulePlugin{plug("beta", wanted.with(op(OpStarting)))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not when the intent is stop",
			start: []rulePlugin{plug("beta", wanted.with(intent("stop")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not when the intent is remove",
			start: []rulePlugin{plug("beta", wanted.with(intent("remove")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not without a transition record",
			start: []rulePlugin{plug("beta", wanted.with(intent("")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not without a service record",
			start: []rulePlugin{plug("beta", wanted.with(noService(), desired("v2")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not when the desired spec is another one",
			start: []rulePlugin{plug("beta", wanted.with(desired("v3")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not when the plugin is disabled",
			start: []rulePlugin{plug("beta", wanted.with(desired("off")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "eligible: not when the desired set dropped the plugin",
			start: []rulePlugin{plug("beta", wanted.with(desired("")))},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
		{
			name:     "guard: eligible: not once shutdown started",
			guard:    "StopAll and the lifetime hook clear the desired set in the section that sets shuttingDown (supervisor.go:1141-1144, :448-450)",
			shutting: true,
			start:    []rulePlugin{plug("beta", wanted)},
			event:    eligible(false),
			want:     ruleWant{out: "false"},
		},
		{
			name:  "eligible: not after the lifetime context ended, before its hook cleared the desired set",
			start: []rulePlugin{plug("beta", wanted)},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			event: eligible(false),
			want:  ruleWant{out: "false"},
		},
	})
}

// settleLocked decides whether the plugin's pending start may run now and, if it may, re-reserves the slot through
// reserveForReconcileLocked. The retry callback has its own policy (TestRuleRetryCallback).
func TestRuleSettle(t *testing.T) {
	settle := func(h *ruleHarness) ([]effect, string) { return h.s.settleLocked("beta"), "" }
	waiting := recBackoff().with(pending("base", "current"))
	const noIncompatiblePending = "a pending start with an incompatible spec reaches settleLocked with a held slot through no production path: planStartLocked returns before marking it, Reconcile refuses a plugin with a stop in flight, a run in flight means the operation is set (8b report, 'Incompatible spec at the restart sites')"

	runTable(t, []ruleRow{
		{
			name:  "settle: a plugin without a service has no pending start",
			start: []rulePlugin{plug("beta", waiting.with(noService(), desired("base")))},
			event: settle,
		},
		{
			name:  "settle: a plugin without a transition record settles nothing",
			start: []rulePlugin{plug("beta", waiting.with(intent("")))},
			event: settle,
		},
		{
			name:  "settle: no pending start, nothing to decide",
			start: []rulePlugin{plug("beta", recBackoff())},
			event: settle,
		},
		{
			name:  "settle: a running process keeps the pending start waiting",
			start: []rulePlugin{plug("beta", recRunning().with(pending("v2", "current"), desired("v2")))},
			event: settle,
		},
		{
			name:  "settle: a stop in flight keeps the pending start waiting",
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotHeld), stopKindOf("release"), pending("base", "current")))},
			event: settle,
		},
		{
			name:  "settle: a run in flight keeps the pending start waiting, the run's own end settles it",
			start: []rulePlugin{plug("beta", waiting.with(op(OpStarting)))},
			event: settle,
		},
		{
			// Mirrors TestReconcileStartDuringStopIsDroppedAfterLaterRun, which pins this known TASK-48 behavior: change both together.
			name:  "settle: a pending start of an older generation is dropped",
			start: []rulePlugin{plug("beta", recBackoff().with(pending("base", "older")))},
			event: settle,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff()}},
		},
		{
			name:  "settle: a pending start for a spec that is no longer wanted is dropped",
			start: []rulePlugin{plug("beta", waiting.with(desired("v3")))},
			event: settle,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired("v3"))}},
		},
		{
			name:  "settle: a pending start of a disabled plugin is dropped",
			start: []rulePlugin{plug("beta", waiting.with(desired("off")))},
			event: settle,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(desired("off"))}},
		},
		{
			name:  "settle: a pending start of a plugin whose intent is stop is dropped",
			start: []rulePlugin{plug("beta", waiting.with(intent("stop")))},
			event: settle,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recBackoff().with(intent("stop"))}},
		},
		{
			name:  "settle: a retry request is dropped when the plugin is no longer in backoff",
			start: []rulePlugin{plug("beta", recStopped().with(pending("base+retry", "current")))},
			event: settle,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": recStopped()}},
		},
		{
			name:  "settle: a retry request in backoff starts with the same spec and keeps its slot",
			start: []rulePlugin{plug("beta", waiting.with(pending("base+retry", "current")))},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(nextAttempt(""), withStartup())},
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "settle: a plain pending start in backoff starts the same way, the backoff does not matter to it",
			start: []rulePlugin{plug("beta", waiting)},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(nextAttempt(""), withStartup())},
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "settle: a changed spec restarts with the slot kept as an unclaimed reservation",
			start: []rulePlugin{plug("beta", recBackoff().with(desired("v2"), pending("v2", "current")))},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("v2"), svcSpec("v2"), failures(1), slot(slotReservedByReconcile), withStartup())},
				effects: []string{"start beta:v2"},
			},
		},
		{
			name:  "settle: a plugin that gave its slot up gets a free one and starts",
			start: []rulePlugin{plug("beta", recStopped().with(desired("v2"), pending("v2", "current")))},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("v2"), svcSpec("v2"), slot(slotReservedByReconcile), withStartup())},
				free:    freeSlots(0),
				effects: []string{"start beta:v2"},
			},
		},
		{
			// Mirrors TestReleaseStopPendingStartWaitsBehindEarlierWaiter.
			name:  "settle: no free slot, the plugin queues behind the holder and its request is spent",
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", recStopped().with(desired("v2"), pending("v2", "current")))},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBlocked().with(desired("v2"), svcSpec("v2"))},
			},
		},
		{
			// Mirrors TestReleaseStopPendingStartWaitsBehindEarlierWaiter.
			name:  "settle: a waiter that sorts earlier is admitted first and the plugin queues",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recStopped().with(desired("v2"), pending("v2", "current")))},
			event: settle,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  recBlocked().with(desired("v2"), svcSpec("v2")),
				},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
			},
		},
		{
			name:  "guard: settle: an incompatible spec releases the slot at once and still gets its start",
			guard: noIncompatiblePending,
			start: []rulePlugin{plug("beta", recBackoff().with(desired("proto9"), pending("proto9", "current")))},
			event: settle,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("proto9"), svcSpec("proto9"), failures(1), withStartup())},
				free:    freeSlots(1),
				effects: []string{"start beta:proto9"},
			},
		},
	})
}
