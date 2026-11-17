package backend

import (
	"context"
	"errors"
	"testing"
)

var (
	errApproveFailedForTest = errors.New("approval failed")
	errRemovalFailedForTest = errors.New("removal failed")
)

func TestSupervisorAbsentTransitionIsRemove(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})

	if got := s.intentOf("absent"); got != IntentRemove {
		t.Fatalf("absent intent = %v, want IntentRemove", got)
	}
}

func TestBeginOperationPairMatrix(t *testing.T) {
	for running := OpStarting; running <= OpInstalling; running++ {
		for incoming := OpStarting; incoming <= OpInstalling; incoming++ {
			t.Run(operationName(running)+"/"+operationName(incoming), func(t *testing.T) {
				s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})

				s.beginLifecycle("p", running, targetFor(running))

				outcome := s.beginLifecycle("p", incoming, targetFor(incoming))
				wantJoined := incoming == running &&
					(running == OpStopping || running == OpRestarting || running == OpDeleting)
				wantSuperseded := !wantJoined &&
					(incoming == OpStopping || incoming == OpDeleting) &&
					(running == OpStarting || running == OpRestarting)
				wantConflict := !wantJoined && !wantSuperseded

				outcomes := 0

				if outcome.joined {
					outcomes++
				}

				if outcome.supersededWorkDone != nil {
					outcomes++
				}

				if outcome.conflict {
					outcomes++
				}

				if outcomes != 1 {
					t.Fatalf("begin outcome has %d result flags: %+v", outcomes, outcome)
				}

				if outcome.joined != wantJoined {
					t.Errorf("joined = %t, want %t", outcome.joined, wantJoined)
				}

				if (outcome.supersededWorkDone != nil) != wantSuperseded {
					t.Errorf("superseded = %t, want %t", outcome.supersededWorkDone != nil, wantSuperseded)
				}

				if outcome.conflict != wantConflict {
					t.Errorf("conflict = %t, want %t", outcome.conflict, wantConflict)
				}
			})
		}
	}
}

func targetFor(op Operation) Intent {
	switch op {
	case OpStopping:
		return IntentStop
	case OpDeleting:
		return IntentRemove
	default:
		return IntentRun
	}
}

func operationName(op Operation) string {
	switch op {
	case OpStarting:
		return "starting"
	case OpStopping:
		return "stopping"
	case OpRestarting:
		return "restarting"
	case OpUpdating:
		return "updating"
	case OpDeleting:
		return "deleting"
	case OpInstalling:
		return "installing"
	default:
		return "unknown"
	}
}

func TestBeginMatrixAndSupersedeClosesOldRun(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	start := s.beginLifecycle("p", OpStarting, IntentRun)
	del := s.beginLifecycle("p", OpDeleting, IntentRemove)

	if del.conflict {
		t.Fatal("delete must win over starting")
	}

	select {
	case <-start.run.done:
	default:
		t.Fatal("superseded startup run left open")
	}

	if !errors.Is(start.run.result, errSuperseded) {
		t.Fatalf("superseded result = %v, want errSuperseded", start.run.result)
	}

	if del.supersededWorkDone != start.run.workDone {
		t.Fatal("delete did not return superseded work completion")
	}

	s2 := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})

	s2.beginLifecycle("p", OpUpdating, IntentRun)

	if got := s2.beginLifecycle("p", OpDeleting, IntentRemove); !got.conflict {
		t.Fatal("delete during update must conflict")
	}

	s3 := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	firstRestart := s3.beginLifecycle("p", OpRestarting, IntentRun)
	secondRestart := s3.beginLifecycle("p", OpRestarting, IntentRun)

	if !secondRestart.joined || secondRestart.run != firstRestart.run {
		t.Fatal("restart during restart must join existing run")
	}

	s4 := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})

	s4.beginLifecycle("p", OpUpdating, IntentRun)

	if got := s4.beginLifecycle("p", OpUpdating, IntentRun); !got.conflict {
		t.Fatal("second update must conflict")
	}
}

func TestCompletionIsGenerationFenced(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	start := s.beginLifecycle("p", OpStarting, IntentRun)

	s.beginLifecycle("p", OpDeleting, IntentRemove)
	s.finishLifecycle(&lifecycleToken{run: start.run}, OpStarting)

	if s.intentOf("p") == IntentRun {
		t.Fatal("stale startup completion published run")
	}
}

func TestTerminalizationIsOneShot(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	inst := s.beginLifecycle("p", OpInstalling, IntentRun)

	s.finishLifecycle(&lifecycleToken{run: inst.run}, OpInstalling)
	s.failLifecycle(&lifecycleToken{run: inst.run}, errApproveFailedForTest)
	s.finishLifecycle(&lifecycleToken{run: inst.run}, OpInstalling)

	if got := s.intentOf("p"); got != IntentRun {
		t.Fatalf("intent after duplicate completion = %v, want IntentRun", got)
	}

	if err := waitRun(inst.run); err != nil {
		t.Fatalf("completed run = %v, want nil", err)
	}
}

func TestDeleteFailKeepsTombstone(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	del := s.beginLifecycle("p", OpDeleting, IntentRemove)

	s.failLifecycle(&lifecycleToken{run: del.run}, errRemovalFailedForTest)

	if got := s.intentOf("p"); got != IntentRemove {
		t.Fatalf("delete failure intent = %v, want IntentRemove", got)
	}

	if err := waitRun(del.run); !errors.Is(err, errRemovalFailedForTest) {
		t.Fatalf("delete failure result = %v", err)
	}
}

func TestReinstallABAKeepsGenerationMonotonic(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})
	start := s.beginLifecycle("p", OpStarting, IntentRun)
	del := s.beginLifecycle("p", OpDeleting, IntentRemove)

	s.finishLifecycle(&lifecycleToken{run: del.run}, OpDeleting)

	reinstall := s.beginLifecycle("p", OpInstalling, IntentRun)

	if reinstall.conflict {
		t.Fatal("reinstall from stable tombstone must be allowed")
	}

	if reinstall.run.generation <= del.run.generation {
		t.Fatalf("reinstall generation = %d, delete generation = %d", reinstall.run.generation, del.run.generation)
	}

	if s.isCurrent(start.run) {
		t.Fatal("stale startup current after delete and reinstall")
	}
}

func TestFailedApprovalReturnsToPending(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{LifetimeCtx: context.Background()})

	setSupervisorTransitionForTest(s, "p", &transition{intent: IntentStop, operation: OpNone})

	inst := s.beginLifecycle("p", OpInstalling, IntentRun)

	s.failLifecycle(&lifecycleToken{run: inst.run}, errApproveFailedForTest)

	if got := s.intentOf("p"); got != IntentStop {
		t.Fatalf("failed approval intent = %v, want IntentStop", got)
	}
}
