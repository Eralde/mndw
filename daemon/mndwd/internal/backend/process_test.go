package backend

import (
	"errors"
	"testing"
	"time"
)

func TestWaitForProcessExitHasBoundedFinalReap(t *testing.T) {
	done := make(chan struct{})
	started := time.Now()

	if waitForProcessExit(done, 10*time.Millisecond) {
		t.Fatal("waitForProcessExit reported an exit for an open channel")
	}

	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("waitForProcessExit took %s", elapsed)
	}
}

func TestProcessExitResultIsBroadcastToStopAndObserver(t *testing.T) {
	wantErr := errors.New("service exited")
	exit := newProcessExit()
	exit.err = wantErr

	close(exit.done)

	if !waitForProcessExit(exit.done, time.Second) {
		t.Fatal("stop path did not observe process exit")
	}

	if err := exit.wait(); !errors.Is(err, wantErr) {
		t.Fatalf("observer error = %v, want %v", err, wantErr)
	}
}
