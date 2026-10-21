package backend

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

var errTraitsTestFailure = errors.New("traits test failure")

func TestExecuteLifecycleOperationTraits(t *testing.T) {
	cases := []struct {
		name          string
		op            Operation
		target        Intent
		prior         Intent
		failIntent    Intent
		successEvent  LifecycleEvent
		exclusive     bool
		blocksTraffic bool
	}{
		{
			name:          "starting",
			op:            OpStarting,
			target:        IntentRun,
			prior:         IntentStop,
			failIntent:    IntentStop,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStarted, Reason: LifecycleReasonReconciled},
			blocksTraffic: false,
		},
		{
			name:          "stopping",
			op:            OpStopping,
			target:        IntentStop,
			prior:         IntentRun,
			failIntent:    IntentStop,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStopped, Reason: LifecycleReasonDisabled},
			exclusive:     true,
			blocksTraffic: true,
		},
		{
			name:          "restarting",
			op:            OpRestarting,
			target:        IntentRun,
			prior:         IntentStop,
			failIntent:    IntentStop,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStarted, Reason: LifecycleReasonReconciled},
			exclusive:     true,
			blocksTraffic: true,
		},
		{
			name:          "updating",
			op:            OpUpdating,
			target:        IntentRun,
			prior:         IntentStop,
			failIntent:    IntentStop,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStarted, Reason: LifecycleReasonReconciled},
			exclusive:     true,
			blocksTraffic: true,
		},
		{
			name:          "deleting",
			op:            OpDeleting,
			target:        IntentRemove,
			prior:         IntentRun,
			failIntent:    IntentRemove,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStopped, Reason: LifecycleReasonRemoved},
			exclusive:     true,
			blocksTraffic: true,
		},
		{
			name:          "installing-run",
			op:            OpInstalling,
			target:        IntentRun,
			prior:         IntentRemove,
			failIntent:    IntentRemove,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStarted, Reason: LifecycleReasonReconciled},
			exclusive:     true,
			blocksTraffic: true,
		},
		{
			name:          "installing-stop",
			op:            OpInstalling,
			target:        IntentStop,
			prior:         IntentRemove,
			failIntent:    IntentRemove,
			successEvent:  LifecycleEvent{Plugin: "p", State: LifecycleStopped, Reason: LifecycleReasonReconciled},
			exclusive:     true,
			blocksTraffic: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			for _, outcome := range []string{"success", "failure"} {
				t.Run(outcome, func(t *testing.T) {
					runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

					if testCase.prior != IntentRemove {
						if err := executeForTest(runtime, "p", OpInstalling, testCase.prior,
							func(context.Context, LifecycleControl) error { return nil }); err != nil {
							t.Fatalf("set prior intent: %v", err)
						}
					}

					var closed []string

					runtime.SetLifecycleHooks(func(pluginID string) {
						closed = append(closed, pluginID)
					})

					var events []LifecycleEvent

					runtime.SetLifecycleObserver(func(event LifecycleEvent) {
						events = append(events, event)
					})

					work := func(context.Context, LifecycleControl) error {
						if got := runtime.BlocksTraffic("p"); got != testCase.blocksTraffic {
							t.Errorf("BlocksTraffic during work = %t, want %t", got, testCase.blocksTraffic)
						}

						if outcome == "failure" {
							return errTraitsTestFailure
						}

						return nil
					}

					err := executeForTest(runtime, "p", testCase.op, testCase.target, work)

					if outcome == "failure" {
						if !errors.Is(err, errTraitsTestFailure) {
							t.Fatalf("ExecuteLifecycle error = %v, want traits test failure", err)
						}

						if got := runtime.intentOf("p"); got != testCase.failIntent {
							t.Errorf("failure intent = %v, want %v", got, testCase.failIntent)
						}

						if len(events) != 0 {
							t.Errorf("failure events = %#v, want none", events)
						}

						return
					}

					if err != nil {
						t.Fatalf("ExecuteLifecycle error = %v, want nil", err)
					}

					if got := runtime.intentOf("p"); got != testCase.target {
						t.Errorf("success intent = %v, want %v", got, testCase.target)
					}

					wantClosed := []string(nil)

					if testCase.exclusive {
						wantClosed = []string{"p"}
					}

					if !reflect.DeepEqual(closed, wantClosed) {
						t.Errorf("closed plugin sockets = %#v, want %#v", closed, wantClosed)
					}

					if !reflect.DeepEqual(events, []LifecycleEvent{testCase.successEvent}) {
						t.Errorf("success events = %#v, want %#v", events, []LifecycleEvent{testCase.successEvent})
					}
				})
			}
		})
	}
}

func TestExecuteLifecycleRejectsUnknownOperation(t *testing.T) {
	for _, op := range []Operation{OpNone, Operation(99)} {
		t.Run(operationName(op), func(t *testing.T) {
			runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
			workCalled := false

			err := executeForTest(runtime, "p", op, IntentRun, func(context.Context, LifecycleControl) error {
				workCalled = true

				return nil
			})

			if !errors.Is(err, errUnknownOperation) {
				t.Fatalf("ExecuteLifecycle error = %v, want errUnknownOperation", err)
			}

			if workCalled {
				t.Fatal("lifecycle work ran for unknown operation")
			}

			if got := runtime.intentOf("p"); got != IntentRemove {
				t.Errorf("intent after rejected operation = %v, want absent-record IntentRemove", got)
			}

			if runtime.BlocksTraffic("p") {
				t.Error("rejected operation blocked traffic")
			}
		})
	}
}

func TestOperationTraitsCoverEveryOperation(t *testing.T) {
	for op := OpStarting; op <= OpInstalling; op++ {
		traits, ok := operationTraits[op]

		if !ok {
			t.Errorf("operation %s is missing traits", operationName(op))

			continue
		}

		if traits.stopReason == "" {
			t.Errorf("operation %s has empty stop reason", operationName(op))
		}
	}

	if _, ok := operationTraits[OpNone]; ok {
		t.Error("OpNone must not have operation traits")
	}
}

func executeForTest(
	r *RuntimeImpl,
	name string,
	op Operation,
	target Intent,
	work func(context.Context, LifecycleControl) error,
) error {
	return r.ExecuteLifecycle(name, op, target, work)
}
