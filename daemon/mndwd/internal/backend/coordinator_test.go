package backend

import (
	"errors"
	"testing"
)

var (
	errApproveFailedForTest = errors.New("approval failed")
	errRemovalFailedForTest = errors.New("removal failed")
)

func TestCoordinatorAbsentRecordIsRemove(t *testing.T) {
	c := newCoordinator()

	if got := c.intentOf("absent"); got != IntentRemove {
		t.Fatalf("absent intent = %v, want IntentRemove", got)
	}
}

func TestBeginOperationPairMatrix(t *testing.T) {
	for running := OpStarting; running <= OpInstalling; running++ {
		for incoming := OpStarting; incoming <= OpInstalling; incoming++ {
			t.Run(operationName(running)+"/"+operationName(incoming), func(t *testing.T) {
				c := newCoordinator()

				c.begin("p", running, targetFor(running))

				outcome := c.begin("p", incoming, targetFor(incoming))
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
	c := newCoordinator()
	start := c.begin("p", OpStarting, IntentRun)
	del := c.begin("p", OpDeleting, IntentRemove)

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

	c2 := newCoordinator()

	c2.begin("p", OpUpdating, IntentRun)

	if got := c2.begin("p", OpDeleting, IntentRemove); !got.conflict {
		t.Fatal("delete during update must conflict")
	}

	c3 := newCoordinator()
	firstRestart := c3.begin("p", OpRestarting, IntentRun)
	secondRestart := c3.begin("p", OpRestarting, IntentRun)

	if !secondRestart.joined || secondRestart.run != firstRestart.run {
		t.Fatal("restart during restart must join existing run")
	}

	c4 := newCoordinator()

	c4.begin("p", OpUpdating, IntentRun)

	if got := c4.begin("p", OpUpdating, IntentRun); !got.conflict {
		t.Fatal("second update must conflict")
	}
}

func TestCompletionIsGenerationFenced(t *testing.T) {
	c := newCoordinator()
	start := c.begin("p", OpStarting, IntentRun)

	c.begin("p", OpDeleting, IntentRemove)
	c.commit(start.run)

	if c.intentOf("p") == IntentRun {
		t.Fatal("stale startup completion published run")
	}
}

func TestTerminalizationIsOneShot(t *testing.T) {
	c := newCoordinator()
	inst := c.begin("p", OpInstalling, IntentRun)

	c.commit(inst.run)
	c.failRestore(inst.run, errApproveFailedForTest)
	c.commit(inst.run)

	if got := c.intentOf("p"); got != IntentRun {
		t.Fatalf("intent after duplicate completion = %v, want IntentRun", got)
	}

	if err := waitRun(inst.run); err != nil {
		t.Fatalf("completed run = %v, want nil", err)
	}
}

func TestDeleteFailKeepsTombstone(t *testing.T) {
	c := newCoordinator()
	del := c.begin("p", OpDeleting, IntentRemove)

	c.fail(del.run, errRemovalFailedForTest)

	if got := c.intentOf("p"); got != IntentRemove {
		t.Fatalf("delete failure intent = %v, want IntentRemove", got)
	}

	if err := waitRun(del.run); !errors.Is(err, errRemovalFailedForTest) {
		t.Fatalf("delete failure result = %v", err)
	}
}

func TestReinstallABAKeepsGenerationMonotonic(t *testing.T) {
	c := newCoordinator()
	start := c.begin("p", OpStarting, IntentRun)
	del := c.begin("p", OpDeleting, IntentRemove)

	c.commit(del.run)

	reinstall := c.begin("p", OpInstalling, IntentRun)

	if reinstall.conflict {
		t.Fatal("reinstall from stable tombstone must be allowed")
	}

	if reinstall.run.generation <= del.run.generation {
		t.Fatalf("reinstall generation = %d, delete generation = %d", reinstall.run.generation, del.run.generation)
	}

	if c.isCurrent(start.run) {
		t.Fatal("stale startup current after delete and reinstall")
	}
}

func TestFailedApprovalReturnsToPending(t *testing.T) {
	c := newCoordinator()

	c.seedIntentForTest("p", IntentStop)

	inst := c.begin("p", OpInstalling, IntentRun)

	c.failRestore(inst.run, errApproveFailedForTest)

	if got := c.intentOf("p"); got != IntentStop {
		t.Fatalf("failed approval intent = %v, want IntentStop", got)
	}
}

func (c *coordinator) seedIntentForTest(name string, intent Intent) {
	c.records[name] = &transition{intent: intent, operation: OpNone}
}
