package backend

import (
	"context"
	"fmt"
	"testing"
)

const midFreedSlot = "inside the critical section of the event that freed the slot, before its tail admits a waiter"

// Slot primitives: the only code that changes Supervisor.reservedServices.
func TestRuleSlotPrimitives(t *testing.T) {
	stoppedInRun := recStopped().with(op(OpStarting))

	runTable(t, []ruleRow{
		{
			name:  "acquire: a free slot is taken and counted",
			start: []rulePlugin{plug("beta", stoppedInRun)},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.acquireServiceSlotLocked(record) }),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stoppedInRun.with(slot(slotHeld))},
				free:    freeSlots(0),
				out:     "true",
			},
		},
		{
			name:  "acquire: no free slot, the request is refused",
			slots: 1,
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", recBlocked())},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.acquireServiceSlotLocked(record) }),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "acquire: a plugin that already owns a slot is answered yes and not counted twice",
			start: []rulePlugin{plug("beta", recStopped().with(op(OpStarting), slot(slotReservedByReconcile)))},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.acquireServiceSlotLocked(record) }),
			want:  ruleWant{out: "true"},
		},
		{
			name:  "release: a held slot without a process is given back and uncounted",
			start: []rulePlugin{plug("beta", stoppedInRun.with(slot(slotHeld)))},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseServiceSlotLocked(record) }),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stoppedInRun},
				free:    freeSlots(1),
				out:     "true",
			},
		},
		{
			name:  "release: an unclaimed reservation is given back too",
			start: []rulePlugin{plug("beta", stoppedInRun.with(slot(slotReservedByReconcile)))},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseServiceSlotLocked(record) }),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stoppedInRun},
				free:    freeSlots(1),
				out:     "true",
			},
		},
		{
			name:  "release: a slot under a process is refused",
			start: []rulePlugin{plug("beta", recRunning())},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseServiceSlotLocked(record) }),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "release: a slot under a launch is refused",
			start: []rulePlugin{plug("beta", recStopped().with(op(OpStarting), slot(slotHeld), proc("launching")))},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseServiceSlotLocked(record) }),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "release: no slot, nothing to give back",
			start: []rulePlugin{plug("beta", stoppedInRun)},
			event: onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseServiceSlotLocked(record) }),
			want:  ruleWant{out: "false"},
		},
	})
}

// claim and unclaim only move a slot the plugin already owns between "reserved by Reconcile" and "held".
func TestRuleSlotClaim(t *testing.T) {
	change := func(call func(*serviceState)) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			call(h.s.plugins["beta"].service)

			return nil, ""
		}
	}
	inRun := recStopped().with(op(OpStarting))

	runTable(t, []ruleRow{
		{
			name:  "claim: Start turns Reconcile's reservation into a held slot",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotReservedByReconcile)))},
			event: change((*serviceState).claimSlot),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": inRun.with(slot(slotHeld))}},
		},
		{
			name:  "claim: a held slot stays held",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotHeld)))},
			event: change((*serviceState).claimSlot),
		},
		{
			// Mirrors TestClaimSlotKeepsNoSlot.
			name:  "claim: a plugin without a slot does not get one",
			start: []rulePlugin{plug("beta", inRun)},
			event: change((*serviceState).claimSlot),
		},
		{
			name:  "unclaim: a restart that keeps its slot makes it an unclaimed reservation",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotHeld)))},
			event: change((*serviceState).unclaimSlot),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": inRun.with(slot(slotReservedByReconcile))}},
		},
		{
			name:  "unclaim: a reservation stays a reservation",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotReservedByReconcile)))},
			event: change((*serviceState).unclaimSlot),
		},
		{
			name:  "unclaim: a plugin without a slot does not get one",
			start: []rulePlugin{plug("beta", inRun)},
			event: change((*serviceState).unclaimSlot),
		},
		{
			name:  "set reservation: reserved marks a held slot as Reconcile's",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotHeld)))},
			event: change(func(s *serviceState) { s.setReservation(true) }),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": inRun.with(slot(slotReservedByReconcile))}},
		},
		{
			name:  "set reservation: not reserved marks the slot as claimed by Start",
			start: []rulePlugin{plug("beta", inRun.with(slot(slotReservedByReconcile)))},
			event: change(func(s *serviceState) { s.setReservation(false) }),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": inRun.with(slot(slotHeld))}},
		},
	})
}

// A restart with a changed spec keeps the slot the old process held, unless the daemon cannot run the new spec.
func TestRuleKeepRestartSlot(t *testing.T) {
	keep := func(form string) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			h.s.keepRestartSlotLocked(h.s.plugins["beta"], ruleSpec("beta", form))

			return nil, ""
		}
	}
	held := recBackoff().with(inState(StateStopped), nextAttempt(""))

	runTable(t, []ruleRow{
		{
			name:  "restart slot: a spec the daemon can run keeps the slot as an unclaimed reservation",
			start: []rulePlugin{plug("beta", held)},
			event: keep("v2"),
			mid:   "inside the critical section of a restart, after the status was reset",
			want:  ruleWant{plugins: map[string]ruleRec{"beta": held.with(slot(slotReservedByReconcile))}},
		},
		{
			name:  "restart slot: an incompatible spec cannot start, so the slot is released at once",
			start: []rulePlugin{plug("beta", held)},
			event: keep("proto9"),
			mid:   "inside the critical section of a restart, after the status was reset",
			want:  ruleWant{plugins: map[string]ruleRec{"beta": held.with(slot(slotNone))}, free: freeSlots(1)},
		},
		{
			name:  "restart slot: a plugin without a slot does not get one",
			start: []rulePlugin{plug("beta", held.with(slot(slotNone)))},
			event: keep("v2"),
			mid:   "inside the critical section of a restart, after the status was reset",
		},
	})
}

// releaseOwnerlessSlotLocked is I14's violation condition limited to Stopped and Failed.
func TestRuleReleaseOwnerlessSlot(t *testing.T) {
	release := onBeta(func(s *Supervisor, record *pluginRecord) bool { return s.releaseOwnerlessSlotLocked(record) })
	ownerless := recStopped().with(slot(slotHeld))
	released := recStopped()
	const midOwnerless = "the tail of an event that just ended the slot's last owner, before this rule releases it"
	const orphan = "an orphaned slot in this state is I14's violation; the checker reports it, this rule leaves it alone"
	const noPath = "no test reaches it: the rule keeps this term so it reads as I14's violation (8b report)"

	runTable(t, []ruleRow{
		{
			name:  "ownerless slot: a stopped plugin that nothing owns gives its slot back (a restart that did not continue)",
			start: []rulePlugin{plug("beta", ownerless)},
			event: release,
			mid:   midOwnerless,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": released}, free: freeSlots(1), out: "true"},
		},
		{
			name:  "ownerless slot: a failed plugin that nothing owns gives its slot back (past the retry cutoff)",
			start: []rulePlugin{plug("beta", ownerless.with(inState(StateFailed), failures(5)))},
			event: release,
			mid:   midOwnerless,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": released.with(inState(StateFailed), failures(5))}, free: freeSlots(1), out: "true"},
		},
		{
			name:  "ownerless slot: a record without a service has nothing to release",
			start: []rulePlugin{plug("beta", ownerless.with(noService()))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: no slot, nothing to release",
			start: []rulePlugin{plug("beta", released)},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: an unclaimed reservation is the start's, not this rule's",
			start: []rulePlugin{plug("beta", ownerless.with(slot(slotReservedByReconcile)))},
			event: release,
			mid:   midOwnerless,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: a plugin in backoff is owned by its retry",
			start: []rulePlugin{plug("beta", recBackoff())},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "guard: ownerless slot: a plugin that is starting is not this rule's to judge",
			guard: orphan,
			start: []rulePlugin{plug("beta", ownerless.with(inState(StateStarting)))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "guard: ownerless slot: a capacity-blocked plugin is not this rule's to judge",
			guard: orphan,
			start: []rulePlugin{plug("beta", ownerless.with(inState(StateCapacityBlocked)))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: a process owns the slot",
			start: []rulePlugin{plug("beta", ownerless.with(proc("registered")))},
			event: release,
			mid:   midOwnerless,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: a launch owns the slot",
			start: []rulePlugin{plug("beta", ownerless.with(proc("launching"), op(OpStarting)))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: a stop in flight owns the slot until its cleanup",
			start: []rulePlugin{plug("beta", ownerless.with(stopKindOf("release")))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "ownerless slot: an active run owns the slot",
			start: []rulePlugin{plug("beta", ownerless.with(op(OpStarting)))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "guard: ownerless slot: a pending start would own the slot",
			guard: noPath,
			start: []rulePlugin{plug("beta", ownerless.with(pending("v2", "current")))},
			event: release,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "guard: ownerless slot: a queued startup would own the slot",
			guard: noPath,
			start: []rulePlugin{plug("beta", ownerless.with(withStartup()))},
			event: release,
			want:  ruleWant{out: "false"},
		},
	})
}

// takeUnstartedReservationLocked gives an unclaimed reservation back and admits the first waiter in the same section.
func TestRuleTakeUnstartedReservation(t *testing.T) {
	take := func(h *ruleHarness) ([]effect, string) {
		taken, effects := h.s.takeUnstartedReservationLocked(h.run["beta"])

		return effects, fmt.Sprint(taken)
	}
	reservedInRun := recStopped().with(op(OpStarting), slot(slotReservedByReconcile))
	freed := recStopped().with(op(OpStarting))

	runTable(t, []ruleRow{
		{
			name:  "unstarted reservation: the plugin's own unclaimed reservation is given back",
			start: []rulePlugin{plug("beta", reservedInRun)},
			event: take,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": freed}, free: freeSlots(1), out: "true"},
		},
		{
			name:  "unstarted reservation: the slot goes to the first waiter in the same section",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", reservedInRun)},
			event: take,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  freed,
				},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
				out:     "true",
			},
		},
		{
			name:  "unstarted reservation: an admitted waiter that never started goes back to stopped",
			start: []rulePlugin{plug("beta", reservedInRun.with(inState(StateCapacityBlocked)))},
			event: take,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": freed}, free: freeSlots(1), out: "true"},
		},
		{
			name:  "unstarted reservation: a slot Start already claimed is not given back",
			start: []rulePlugin{plug("beta", recStopped().with(op(OpStarting), slot(slotHeld), inState(StateStarting)))},
			event: take,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "unstarted reservation: a plugin without a slot has nothing to give back",
			start: []rulePlugin{plug("beta", freed)},
			event: take,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "unstarted reservation: a plugin without a service has nothing to give back",
			start: []rulePlugin{plug("beta", freed.with(noService()))},
			event: take,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "unstarted reservation: a run that is no longer current gives nothing back",
			start: []rulePlugin{plug("beta", recStopped().with(slot(slotReservedByReconcile)))},
			event: take,
			want:  ruleWant{out: "false"},
		},
		{
			name:  "unstarted reservation: no run, nothing is current",
			start: []rulePlugin{plug("beta", reservedInRun)},
			event: func(h *ruleHarness) ([]effect, string) {
				taken, effects := h.s.takeUnstartedReservationLocked(nil)

				return effects, fmt.Sprint(taken)
			},
			want: ruleWant{out: "false"},
		},
	})
}

// Admission hands free slots to admissible capacity-blocked plugins in lessServiceSpec order.
func TestRuleAdmit(t *testing.T) {
	admit := func(h *ruleHarness) ([]effect, string) { return h.s.admitLocked(), "" }
	admitted := func(startup bool) ruleRec {
		rec := recBlocked().with(slot(slotReservedByReconcile))

		if startup {
			rec = rec.with(withStartup())
		}

		return rec
	}

	runTable(t, []ruleRow{
		{
			name:  "admit: a free slot goes to the waiter, which gets a startup effect",
			start: []rulePlugin{plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "admit: no free slot, nobody is admitted",
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", recBlocked())},
			event: admit,
		},
		{
			name:  "admit: one slot, two waiters, the earlier by plugin ID wins",
			start: []rulePlugin{plug("beta", recBlocked()), plug("alpha", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
			},
		},
		{
			name: "admit: one slot, a builtin waiter wins against an earlier plugin ID",
			start: []rulePlugin{
				plug("alpha", recBlocked()),
				plug("zeta", recBlocked().with(desired("builtin"), svcSpec("builtin"))),
			},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"zeta": admitted(true).with(desired("builtin"), svcSpec("builtin"))},
				free:    freeSlots(0),
				effects: []string{"start zeta:builtin"},
			},
		},
		{
			name:  "admit: two free slots, three waiters, the first two in order are admitted",
			slots: 2,
			start: []rulePlugin{plug("gamma", recBlocked()), plug("alpha", recBlocked()), plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": admitted(true), "beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start alpha:base", "start beta:base"},
			},
		},
		{
			name:  "admit: a waiter whose own operation is running is not admissible and is skipped",
			start: []rulePlugin{plug("alpha", recBlocked().with(op(OpStarting))), plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "admit: a waiter with a stop in flight is skipped",
			start: []rulePlugin{plug("alpha", recBlocked().with(stopKindOf("release"))), plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "admit: a waiter with a stop in flight keeps its recorded spec, admission does not touch it",
			start: []rulePlugin{plug("alpha", recBlocked().with(stopKindOf("keep"), desired("v2")))},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": recBlocked().with(stopKindOf("keep"), desired("v2"))},
				free:    freeSlots(1),
			},
		},
		{
			name:  "admit: a waiter whose intent is stop or remove is skipped",
			start: []rulePlugin{plug("alpha", recBlocked().with(intent("stop"))), plug("beta", recBlocked().with(intent("remove"))), plug("gamma", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"gamma": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start gamma:base"},
			},
		},
		{
			name:  "admit: a disabled or unwanted waiter is skipped",
			start: []rulePlugin{plug("alpha", recBlocked().with(desired("off"))), plug("beta", recBlocked().with(desired(""))), plug("gamma", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"gamma": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start gamma:base"},
			},
		},
		{
			name:  "admit: a plugin that is not capacity-blocked is skipped",
			start: []rulePlugin{plug("alpha", recStopped()), plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "admit: a waiter that already owns a slot is skipped",
			slots: 2,
			start: []rulePlugin{plug("alpha", admitted(false)), plug("beta", recBlocked())},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
			},
		},
		{
			name:  "admit: a queued startup is not queued twice",
			start: []rulePlugin{plug("beta", recBlocked().with(withStartup()))},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": admitted(true)},
				free:    freeSlots(0),
			},
		},
		{
			// Mirrors TestAdmitDoesNothingAfterShutdownStarts.
			name:     "guard: admit: once shutdown started nobody is admitted",
			guard:    "StopAll and the lifetime hook clear every desired spec when they set shuttingDown (supervisor.go:1141-1144, :448-450), so no waiter is admissible then",
			shutting: true,
			start:    []rulePlugin{plug("beta", recBlocked())},
			event:    admit,
		},
		{
			name:  "guard: admit: before startDesired is set nobody is admitted",
			guard: "NewRuntime sets startDesired when it builds the supervisor (runtime.go:115), before any caller can reconcile; only tests build one without it",
			start: []rulePlugin{plug("beta", recBlocked())},
			prep:  func(h *ruleHarness) { h.s.startDesired = nil },
			event: admit,
		},
		{
			name:  "admit: after the lifetime context ended nobody is admitted, before its hook cleared the desired set",
			start: []rulePlugin{plug("beta", recBlocked())},
			prep: func(h *ruleHarness) {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				h.s.lifetimeCtx = ctx
			},
			event: admit,
		},
		{
			name:  "guard: admit: a waiter with an unsupported protocol is admitted without a slot",
			guard: "an incompatible spec never stays capacity-blocked: prepareReservationLocked moves a blocked record to stopped (supervisor.go:1488-1489)",
			start: []rulePlugin{plug("beta", recBlocked().with(desired("proto9"), svcSpec("proto9")))},
			event: admit,
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("proto9"), svcSpec("proto9"), withStartup())},
				effects: []string{"start beta:proto9"},
			},
		},
	})
}

// requestSlotLocked is how a starting plugin asks for a slot: it joins the queue for one pass.
func TestRuleRequestSlot(t *testing.T) {
	request := func(form string) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			granted, effects := h.s.requestSlotLocked(h.s.plugins["beta"], ruleSpec("beta", form))

			return effects, fmt.Sprint(granted)
		}
	}
	requester := recStopped().with(op(OpStarting))
	granted := requester.with(slot(slotHeld))

	runTable(t, []ruleRow{
		{
			name:  "request: a free slot and no waiter, the requester gets it",
			start: []rulePlugin{plug("beta", requester)},
			event: request("base"),
			mid:   "inside planStartLocked, before the status moves to starting",
			want:  ruleWant{plugins: map[string]ruleRec{"beta": granted}, free: freeSlots(0), out: "true"},
		},
		{
			name:  "request: a plugin that owns a slot keeps it and does not ask the queue (a restart)",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recBackoff().with(op(OpStarting)))},
			event: request("base"),
			want:  ruleWant{out: "true"},
		},
		{
			name:  "request: an earlier waiter is admitted first and the requester is refused",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", requester)},
			event: request("base"),
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup())},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
				out:     "false",
			},
		},
		{
			name:  "request: a later waiter stays blocked and the requester gets the slot",
			start: []rulePlugin{plug("beta", requester), plug("gamma", recBlocked())},
			event: request("base"),
			mid:   midFreedSlot,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": granted}, free: freeSlots(0), out: "true"},
		},
		{
			name:  "request: no free slot, the requester is refused and nobody starts",
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", requester)},
			event: request("base"),
			want:  ruleWant{out: "false"},
		},
		{
			name:  "request: two free slots, an earlier waiter and the requester both get one",
			slots: 2,
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", requester)},
			event: request("base"),
			mid:   midFreedSlot,
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()), "beta": granted},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
				out:     "true",
			},
		},
		{
			name:     "guard: request: once shutdown started the requester alone is decided",
			guard:    "planStartLocked and prepareReservationLocked's callers refuse once shuttingDown is set, so no request reaches the queue then (supervisor.go:1724, :1334)",
			shutting: true,
			start:    []rulePlugin{plug("alpha", recBlocked()), plug("beta", requester)},
			event:    request("base"),
			want:     ruleWant{plugins: map[string]ruleRec{"beta": granted}, free: freeSlots(0), out: "true"},
		},
	})
}

// settleAndAdmitLocked is the tail every event rule ends with: the plugin's own pending start, the slot it no longer
// owns, then admission.
func TestRuleSettleAndAdmit(t *testing.T) {
	tail := func(h *ruleHarness) ([]effect, string) { return h.s.settleAndAdmitLocked("beta"), "" }
	const midTail = "the tail of an event, after the event's own writes"

	runTable(t, []ruleRow{
		{
			name:  "tail: a failed plugin gives its slot to the first waiter in the same section",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recBackoff().with(inState(StateFailed), failures(5), nextAttempt("")))},
			event: tail,
			mid:   midTail,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  recBackoff().with(inState(StateFailed), failures(5), nextAttempt(""), slot(slotNone)),
				},
				effects: []string{"start alpha:base"},
			},
		},
		{
			name:  "tail: a restart that did not continue gives its slot to the first waiter",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recStopped().with(slot(slotHeld)))},
			event: tail,
			mid:   midTail,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  recStopped(),
				},
				effects: []string{"start alpha:base"},
			},
		},
		{
			name:  "tail: a plugin in backoff keeps its slot and the waiter stays blocked",
			start: []rulePlugin{plug("alpha", recBlocked()), plug("beta", recBackoff())},
			event: tail,
			mid:   midTail,
		},
		{
			name: "tail: the plugin's own pending start is decided before admission, so it wins against a later waiter",
			start: []rulePlugin{
				plug("beta", recStopped().with(desired("v2"), pending("v2", "current"))),
				plug("gamma", recBlocked()),
			},
			event: tail,
			mid:   midTail,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("v2"), svcSpec("v2"), slot(slotReservedByReconcile), withStartup())},
				free:    freeSlots(0),
				effects: []string{"start beta:v2"},
			},
		},
		{
			name: "tail: the same pending start waits behind a waiter that sorts earlier, its pending start is spent and the plugin queues",
			start: []rulePlugin{
				plug("alpha", recBlocked()),
				plug("beta", recStopped().with(desired("v2"), pending("v2", "current"))),
			},
			event: tail,
			mid:   midTail,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  recStopped().with(desired("v2"), svcSpec("v2"), inState(StateCapacityBlocked)),
				},
				free:    freeSlots(0),
				effects: []string{"start alpha:base"},
			},
		},
	})
}

func runTable(t *testing.T, rows []ruleRow) {
	t.Helper()

	runRuleTable(t, ruleTable{}, rows)
}
