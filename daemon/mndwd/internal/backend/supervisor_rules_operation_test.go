package backend

import (
	"fmt"
	"testing"
)

// beginLocked: one operation owns a plugin at a time; a joinable one joins, a superseding one supersedes a
// supersedable one, anything else conflicts.
func TestRuleBeginOperation(t *testing.T) {
	begin := func(operation Operation, want Intent) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			oldRun := h.run["beta"]
			outcome := h.s.beginLocked("beta", operation, want)

			switch {
			case outcome.conflict:
				return nil, "conflict"
			case outcome.joined:
				return nil, "joined"
			case outcome.supersededWorkDone != nil:
				return nil, fmt.Sprintf("superseded (old run completed=%t result=%v canceled=%t)", oldRun.completed, oldRun.result, oldRun.ctx.Err() != nil)
			default:
				return nil, "new"
			}
		}
	}
	idle := func(name string) ruleRec { return ruleRec{Intent: name} }
	active := func(name string, operation Operation) ruleRec { return ruleRec{Intent: name, Op: operation} }

	runTable(t, []ruleRow{
		{
			name:  "begin: a plugin the supervisor never saw starts a run, and removal is what it falls back to",
			event: begin(OpStarting, IntentRun),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "run", Op: OpStarting, Prior: "remove"}}, out: "new"},
		},
		{
			name:  "begin: an idle plugin starts a run and remembers the intent it had",
			start: []rulePlugin{plug("beta", idle("stop"))},
			event: begin(OpStarting, IntentRun),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "run", Op: OpStarting, Prior: "stop"}}, out: "new"},
		},
		{
			name:  "begin: the run's target is the intent it wants",
			start: []rulePlugin{plug("beta", idle("run"))},
			event: begin(OpStopping, IntentStop),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "stop", Op: OpStopping, Target: "stop"}}, out: "new"},
		},
		{
			name:  "begin: a plugin being removed refuses a start",
			start: []rulePlugin{plug("beta", idle("remove"))},
			event: begin(OpStarting, IntentRun),
			want:  ruleWant{out: "conflict"},
		},
		{
			name:  "begin: a plugin being removed accepts an install",
			start: []rulePlugin{plug("beta", idle("remove"))},
			event: begin(OpInstalling, IntentRun),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "run", Op: OpInstalling, Prior: "remove"}}, out: "new"},
		},
		{
			name:  "begin: a plugin being removed accepts a delete",
			start: []rulePlugin{plug("beta", idle("remove"))},
			event: begin(OpDeleting, IntentRemove),
			want:  ruleWant{plugins: map[string]ruleRec{"beta": {Intent: "remove", Op: OpDeleting, Prior: "remove", Target: "remove"}}, out: "new"},
		},
		{
			name:  "begin: an operation that cannot be joined conflicts with itself",
			start: []rulePlugin{plug("beta", active("run", OpStarting))},
			event: begin(OpStarting, IntentRun),
			want:  ruleWant{out: "conflict"},
		},
		{
			name:  "begin: a joinable operation joins the one in flight",
			start: []rulePlugin{plug("beta", active("stop", OpStopping))},
			event: begin(OpStopping, IntentStop),
			want:  ruleWant{out: "joined"},
		},
		{
			name:  "begin: a restart joins a restart",
			start: []rulePlugin{plug("beta", active("run", OpRestarting))},
			event: begin(OpRestarting, IntentRun),
			want:  ruleWant{out: "joined"},
		},
		{
			name:  "begin: a stop supersedes a start in flight, completes it as superseded and cancels it",
			start: []rulePlugin{plug("beta", active("run", OpStarting))},
			event: begin(OpStopping, IntentStop),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": {Intent: "stop", Op: OpStopping, Target: "stop"}},
				out:     "superseded (old run completed=true result=operation superseded canceled=true)",
			},
		},
		{
			name:  "begin: a stop supersedes a restart in flight",
			start: []rulePlugin{plug("beta", active("run", OpRestarting))},
			event: begin(OpStopping, IntentStop),
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": {Intent: "stop", Op: OpStopping, Target: "stop"}},
				out:     "superseded (old run completed=true result=operation superseded canceled=true)",
			},
		},
		{
			name:  "begin: an update in flight is not supersedable",
			start: []rulePlugin{plug("beta", active("run", OpUpdating))},
			event: begin(OpStopping, IntentStop),
			want:  ruleWant{out: "conflict"},
		},
		{
			name:  "begin: a delete in flight is not supersedable",
			start: []rulePlugin{plug("beta", active("remove", OpDeleting))},
			event: begin(OpStopping, IntentStop),
			want:  ruleWant{out: "conflict"},
		},
		{
			name:  "begin: a stop in flight is not supersedable",
			start: []rulePlugin{plug("beta", active("stop", OpStopping))},
			event: begin(OpDeleting, IntentRemove),
			want:  ruleWant{out: "conflict"},
		},
		{
			name:  "begin: an operation that does not supersede conflicts with a start in flight",
			start: []rulePlugin{plug("beta", active("run", OpStarting))},
			event: begin(OpUpdating, IntentRun),
			want:  ruleWant{out: "conflict"},
		},
	})
}

// The rules that end a run: the intent the plugin is left with depends on how the run ended, and every one of them
// settles the plugin's pending start and admits waiters in the same critical section.
func TestRuleEndOperation(t *testing.T) {
	end := func(call func(s *Supervisor, run *operationRun) []effect) func(h *ruleHarness) ([]effect, string) {
		return func(h *ruleHarness) ([]effect, string) {
			generation := h.s.nextGen
			effects := call(h.s, h.run["beta"])

			return effects, fmt.Sprintf("nextGen+%d", h.s.nextGen-generation)
		}
	}
	commit := end(func(s *Supervisor, run *operationRun) []effect { return s.commitLocked(run) })
	failRestore := end(func(s *Supervisor, run *operationRun) []effect { return s.failRestoreLocked(run, errSuperseded) })
	failKeep := end(func(s *Supervisor, run *operationRun) []effect { return s.failKeepLocked(run, errSuperseded) })
	fail := end(func(s *Supervisor, run *operationRun) []effect { return s.failLocked(run, errSuperseded) })
	forceStop := end(func(s *Supervisor, run *operationRun) []effect { return s.forceStopLocked(run, errSuperseded) })
	running := recBackoff().with(op(OpStarting))
	ended := func(name string) ruleRec { return running.with(op(OpNone), intent(name)) }

	runTable(t, []ruleRow{
		{
			name:  "commit: the run ends and the plugin is left with the intent the run wanted",
			start: []rulePlugin{plug("beta", running.with(target("stop")))},
			event: commit,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("stop").with(target("stop"))}, out: "nextGen+0"},
		},
		{
			name:  "commit: a run that is no longer current changes nothing",
			start: []rulePlugin{plug("beta", recBackoff().with(intent("stop")))},
			event: commit,
			want:  ruleWant{out: "nextGen+0"},
		},
		{
			name:  "commit: no run, nothing to end",
			start: []rulePlugin{plug("beta", running)},
			event: end(func(s *Supervisor, _ *operationRun) []effect { return s.commitLocked(nil) }),
			want:  ruleWant{out: "nextGen+0"},
		},
		{
			name:  "commit: the end of a remove run starts a new generation, so older requests are stale",
			start: []rulePlugin{plug("beta", running.with(intent("remove"), target("remove")))},
			event: commit,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("remove").with(target("remove"))}, out: "nextGen+1"},
		},
		{
			name:  "commit: a remove run that is no longer current starts no generation",
			start: []rulePlugin{plug("beta", recBackoff().with(intent("remove"), target("remove")))},
			event: commit,
			want:  ruleWant{out: "nextGen+0"},
		},
		{
			name:  "fail and restore: the plugin goes back to the intent it had before the run",
			start: []rulePlugin{plug("beta", running.with(prior("stop")))},
			event: failRestore,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("stop").with(prior("stop"))}, out: "nextGen+0"},
		},
		{
			name:  "fail and keep: the plugin keeps the intent the run wanted",
			start: []rulePlugin{plug("beta", running.with(prior("stop"), target("run")))},
			event: failKeep,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("run").with(prior("stop"))}, out: "nextGen+0"},
		},
		{
			name:  "fail: a start restores the intent it replaced",
			start: []rulePlugin{plug("beta", running.with(prior("stop")))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("stop").with(prior("stop"))}, out: "nextGen+0"},
		},
		{
			name:  "fail: a stop keeps the intent it wanted",
			start: []rulePlugin{plug("beta", running.with(op(OpStopping), prior("run"), target("stop")))},
			event: fail,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("stop").with(target("stop"))}, out: "nextGen+0"},
		},
		{
			name:  "force stop: the plugin is left stopped whatever the run wanted",
			start: []rulePlugin{plug("beta", running.with(prior("run"), target("run")))},
			event: forceStop,
			want:  ruleWant{plugins: map[string]ruleRec{"beta": ended("stop")}, out: "nextGen+0"},
		},
		{
			name:  "end of a run: the plugin's own pending start settles in the same section",
			start: []rulePlugin{plug("beta", running.with(pending("base", "current")))},
			event: commit,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": ended("run").with(nextAttempt(""), withStartup())},
				effects: []string{"start beta:base"},
				out:     "nextGen+0",
			},
		},
		{
			name:  "end of a run: a waiter whose own operation just ended is admitted in the same section",
			start: []rulePlugin{plug("beta", recBlocked().with(op(OpStarting)))},
			event: commit,
			want: ruleWant{
				plugins: map[string]ruleRec{"beta": recBlocked().with(slot(slotReservedByReconcile), withStartup())},
				free:    freeSlots(0),
				effects: []string{"start beta:base"},
				out:     "nextGen+0",
			},
		},
		{
			// Mirrors TestFailedStartReleasesSlotWhenItsRunEnds.
			name: "end of a run: a failed start gives its slot to the first waiter",
			start: []rulePlugin{
				plug("alpha", recBlocked()),
				plug("beta", running.with(inState(StateFailed), failures(5), nextAttempt(""))),
			},
			event: commit,
			want: ruleWant{
				plugins: map[string]ruleRec{
					"alpha": recBlocked().with(slot(slotReservedByReconcile), withStartup()),
					"beta":  ended("run").with(inState(StateFailed), failures(5), nextAttempt(""), slot(slotNone)),
				},
				effects: []string{"start alpha:base"},
				out:     "nextGen+0",
			},
		},
	})
}

// completeSupersededLocked closes the run of a superseded operation so its waiters wake.
func TestRuleCompleteSuperseded(t *testing.T) {
	complete := func(h *ruleHarness) ([]effect, string) {
		run := h.run["beta"]

		h.s.completeSupersededLocked(run)

		select {
		case <-run.done:
			return nil, fmt.Sprintf("completed=%t result=%v done", run.completed, run.result)
		default:
			return nil, fmt.Sprintf("completed=%t result=%v open", run.completed, run.result)
		}
	}

	runRuleTable(t, ruleTable{tolerate: []invariantID{invI9}}, []ruleRow{
		{
			name:  "superseded: an active run completes with the superseded error and wakes its waiters",
			start: []rulePlugin{plug("beta", ruleRec{Intent: "run", Op: OpStarting})},
			mid:   "inside beginLocked, which replaces the completed run with the new one in the same critical section (supervisor.go:688-702)",
			event: complete,
			want:  ruleWant{out: "completed=true result=operation superseded done"},
		},
		{
			name:  "superseded: a run that already completed is not completed twice",
			start: []rulePlugin{plug("beta", ruleRec{Intent: "run"})},
			event: complete,
			want:  ruleWant{out: "completed=true result=<nil> done"},
		},
		{
			name:  "superseded: no run, nothing to complete",
			start: []rulePlugin{plug("beta", ruleRec{Intent: "run"})},
			event: func(h *ruleHarness) ([]effect, string) {
				h.s.completeSupersededLocked(nil)

				return nil, ""
			},
		},
	})
}
