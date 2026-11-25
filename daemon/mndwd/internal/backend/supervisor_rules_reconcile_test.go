package backend

import (
	"context"
	"fmt"
	"testing"
)

// Reconcile is the supervisor's reservation rule: it sets the desired spec, records the intent, reserves slots in
// lessServiceSpec order and plans what the runtime starts, stops and removes.
func TestRuleReconcile(t *testing.T) {
	reconcile := func(specs ...ServiceSpec) func(h *ruleHarness) string {
		return func(h *ruleHarness) string {
			plan := h.s.Reconcile(context.Background(), specs)
			h.effects = plan.effects

			return fmt.Sprintf("start=%v stop=%v remove=%v", plan.startIDs, plan.stopIDs, plan.removeIDs)
		}
	}
	form := func(id, name string) ServiceSpec { return ruleSpec(id, name) }
	disabled := func(id string) ServiceSpec {
		spec := ruleSpec(id, "base")
		spec.Enabled = false

		return spec
	}
	removing := func(id string) ServiceSpec {
		spec := ruleSpec(id, "base")
		spec.RemovalPending = true

		return spec
	}
	// reserved is the plugin Reconcile just reserved a slot for, before its Start.
	reserved := recStopped().with(slot(slotReservedByReconcile))
	// stopping is a plugin whose disable stop is still in flight after its timeout.
	stopping := recStopped().with(desired("off"), slot(slotHeld), stopKindOf("release"), intent("stop"))

	runTable(t, []ruleRow{
		{
			name:  "reconcile: a new enabled plugin with a free slot is reserved and planned to start",
			drive: reconcile(form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": reserved},
				free:    freeSlots(0),
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a new enabled plugin with no free slot queues as capacity-blocked and is not planned",
			start: []rulePlugin{plug("alpha", recRunning())},
			drive: reconcile(form("alpha", "base"), form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBlocked()},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			// Status() shows these fields to the UI. Mutations finish-protocols and finish-compat drop them.
			name:  "reconcile: a plugin that queues as capacity-blocked records the protocol it needs and the ones supported",
			start: []rulePlugin{plug("alpha", recRunning())},
			drive: func(h *ruleHarness) string {
				out := reconcile(form("alpha", "base"), form("beta", "base"))(h)

				h.s.mu.Lock()

				defer h.s.unlock()

				status := h.s.plugins["beta"].service.status

				return fmt.Sprintf("%s required=%d supported=%v compatible=%v", out, status.RequiredProtocol,
					status.SupportedProtocols, status.Compatible != nil && *status.Compatible)
			},
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBlocked()},
				out:     "start=[] stop=[] remove=[] required=1 supported=[1] compatible=true",
			},
		},
		{
			name:  "reconcile: an unsupported protocol is planned without a slot, Start will report it",
			drive: reconcile(form("beta", "proto9")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("proto9"), svcSpec("proto9"))},
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a capacity-blocked plugin whose spec became unsupported goes back to stopped",
			start: []rulePlugin{plug("alpha", recRunning()), plug("beta", recBlocked())},
			drive: reconcile(form("alpha", "base"), form("beta", "proto9")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("proto9"), svcSpec("proto9"))},
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			// The plugin was disabled while it waited, so admission skips it (intent stop) and its stop has not run yet.
			// Re-enabled, it asks for its slot as a requester that is admissible itself: the admission pass must not
			// queue it a second time as a waiter, or it would be planned here and started by a startup effect too.
			name:  "reconcile: a capacity-blocked plugin re-enabled before its stop ran is reserved and planned once",
			start: []rulePlugin{plug("beta", recBlocked().with(desired("off"), intent("stop")))},
			drive: reconcile(form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": reserved.with(inState(StateCapacityBlocked))},
				free:    freeSlots(0),
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a plugin admitted but not started yet keeps its reservation and is planned again",
			start: []rulePlugin{plug("beta", recBlocked().with(slot(slotReservedByReconcile), withStartup()))},
			drive: reconcile(form("beta", "base")),
			want:  ruleWant{out: "start=[beta] stop=[] remove=[]"},
		},
		{
			name:  "reconcile: a stopped plugin that holds Reconcile's reservation is planned again",
			start: []rulePlugin{plug("beta", reserved)},
			drive: reconcile(form("beta", "base")),
			want:  ruleWant{out: "start=[beta] stop=[] remove=[]"},
		},
		{
			name:  "reconcile: a stopped plugin without a slot is reserved when a slot is free",
			start: []rulePlugin{plug("beta", recStopped())},
			drive: reconcile(form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": reserved},
				free:    freeSlots(0),
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a ready plugin with the same spec is left alone",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: reconcile(form("beta", "base")),
			want:  ruleWant{out: "start=[] stop=[] remove=[]"},
		},
		{
			name:  "reconcile: a plugin in backoff with the same spec is left to its retry",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry()))},
			drive: reconcile(form("beta", "base")),
			want:  ruleWant{out: "start=[] stop=[] remove=[]"},
		},
		{
			name:  "reconcile: a changed spec for a running plugin is planned for restart, its own spec waits for Start",
			start: []rulePlugin{plug("beta", recRunning())},
			drive: reconcile(form("beta", "v2")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recRunning().with(desired("v2"))},
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a changed spec stops the retry timer of a plugin in backoff and plans the restart",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry()))},
			drive: reconcile(form("beta", "v2")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(desired("v2"))},
				out:     "start=[beta] stop=[] remove=[]",
			},
		},
		{
			// Mirrors TestReenableDuringTimedOutDisableStartsAtCleanup.
			name:  "reconcile: re-enabled during a stop in flight, nothing is planned and the start is recorded as pending",
			start: []rulePlugin{plug("beta", stopping)},
			drive: reconcile(form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stopping.with(desired("base"), intent("run"), pending("base", "current"))},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: re-enabled with a changed spec during a stop that still has its process, the old spec stays",
			start: []rulePlugin{plug("beta", stopping.with(proc("registered")))},
			drive: reconcile(form("beta", "v2")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stopping.with(proc("registered"), desired("v2"), intent("run"), pending("v2", "current"))},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: re-enabled with a changed spec during a stop whose process is gone, the stopped record takes it",
			start: []rulePlugin{plug("beta", stopping)},
			drive: reconcile(form("beta", "v2")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": stopping.with(desired("v2"), svcSpec("v2"), intent("run"), pending("v2", "current"))},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a disabled plugin in backoff is planned to stop, its retry and pending start are dropped",
			start: []rulePlugin{plug("beta", recBackoff().with(withRetry(), pending("base", "current")))},
			drive: reconcile(disabled("beta")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(desired("off"), intent("stop"))},
				out:     "start=[] stop=[beta] remove=[]",
			},
		},
		{
			name:  "reconcile: a disabled plugin that is stopped without a slot has nothing to stop",
			start: []rulePlugin{plug("beta", recStopped())},
			drive: reconcile(disabled("beta")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recStopped().with(desired("off"), intent("stop"))},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a disabled plugin that holds only Reconcile's reservation is planned to stop",
			start: []rulePlugin{plug("beta", reserved)},
			drive: reconcile(disabled("beta")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": reserved.with(desired("off"), intent("stop"))},
				out:     "start=[] stop=[beta] remove=[]",
			},
		},
		{
			name:  "reconcile: a plugin marked for removal loses its desired spec, its pending start and is planned for removal",
			start: []rulePlugin{plug("beta", recBackoff().with(pending("base", "current")))},
			drive: reconcile(removing("beta")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(desired(""), intent("remove"))},
				out:     "start=[] stop=[] remove=[beta]",
			},
		},
		{
			name:  "reconcile: a plugin that left the desired set is removed and its retry stopped",
			slots: 2,
			start: []rulePlugin{plug("alpha", recStopped()), plug("beta", recBackoff().with(withRetry()))},
			drive: reconcile(form("alpha", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": reserved, "beta": recBackoff().with(desired(""), intent("remove"))},
				free:    freeSlots(0),
				out:     "start=[alpha] stop=[] remove=[beta]",
			},
		},
		{
			name:  "reconcile: a plugin that left the desired set while its run is active only loses its spec and retry",
			slots: 2,
			start: []rulePlugin{plug("alpha", recStopped()), plug("beta", recBackoff().with(withRetry(), op(OpStarting)))},
			drive: reconcile(form("alpha", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"alpha": reserved, "beta": recBackoff().with(desired(""), op(OpStarting))},
				free:    freeSlots(0),
				out:     "start=[alpha] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: a plugin whose intent is remove stays removed whatever the spec says",
			start: []rulePlugin{plug("beta", recBackoff().with(intent("remove")))},
			drive: reconcile(form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(desired(""), intent("remove"))},
				out:     "start=[] stop=[] remove=[beta]",
			},
		},
		{
			name:  "reconcile: a plugin with a run in flight is not touched by an enabled spec",
			start: []rulePlugin{plug("beta", recBackoff().with(op(OpStarting)))},
			drive: reconcile(form("beta", "v2")),
			want:  ruleWant{out: "start=[] stop=[] remove=[]"},
		},
		{
			name:  "reconcile: a disabled spec still stops the retry and drops the pending start of a plugin with a run in flight",
			start: []rulePlugin{plug("beta", recBackoff().with(op(OpStarting), withRetry(), pending("base", "current")))},
			drive: reconcile(disabled("beta")),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBackoff().with(op(OpStarting))},
				out:     "start=[] stop=[] remove=[]",
			},
		},
		{
			name:     "reconcile: once shutdown started nothing is planned and nothing changes",
			shutting: true,
			start:    []rulePlugin{plug("beta", recStopped().with(desired("")))},
			drive:    reconcile(form("beta", "base")),
			want:     ruleWant{out: "start=[] stop=[] remove=[]"},
		},
		{
			// Mirrors TestReconcileReservesBuiltinServicesBeforeUserServices.
			name:  "reconcile: slots are reserved builtin first, then by plugin ID",
			slots: 3,
			drive: reconcile(form("alpha", "base"), form("zeta", "builtin"), form("beta", "base")),
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": reserved,
					"beta":  reserved,
					"zeta":  reserved.with(desired("builtin"), svcSpec("builtin")),
				},
				free: freeSlots(0),
				out:  "start=[zeta alpha beta] stop=[] remove=[]",
			},
		},
		{
			name:  "reconcile: with one slot the builtin plugin is reserved and the earlier plugin ID queues",
			drive: reconcile(form("alpha", "base"), form("zeta", "builtin")),
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked(),
					"zeta":  reserved.with(desired("builtin"), svcSpec("builtin")),
				},
				free: freeSlots(0),
				out:  "start=[zeta] stop=[] remove=[]",
			},
		},
	})
}

// A canceled context plans nothing and changes nothing.
func TestRuleReconcileCanceledContext(t *testing.T) {
	runTable(t, []ruleRow{
		{
			name:  "reconcile: a canceled context plans nothing and changes nothing",
			start: []rulePlugin{plug("beta", recStopped())},
			drive: func(h *ruleHarness) string {
				ctx, cancel := context.WithCancel(context.Background())

				cancel()

				plan := h.s.Reconcile(ctx, []ServiceSpec{ruleSpec("beta", "v2")})

				return fmt.Sprintf("start=%v stop=%v remove=%v", plan.startIDs, plan.stopIDs, plan.removeIDs)
			},
			want: ruleWant{out: "start=[] stop=[] remove=[]"},
		},
	})
}
