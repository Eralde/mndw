package monitor

import (
	"context"
	"os"
	"runtime"
	"testing"
	"time"

	"smart-page/internal/model"
)

type cachedProcessReader struct {
	reads    int
	ownPID   int
	childPID int
	checked  chan struct{}
}

func (reader *cachedProcessReader) ListPIDs() ([]int, error) {
	reader.reads++

	return []int{reader.ownPID, reader.childPID}, nil
}

func (reader *cachedProcessReader) Comm(pid int) (string, error) {
	reader.reads++

	if pid == reader.ownPID {
		return "smart-page", nil
	}

	close(reader.checked)

	return "smartd-helper", nil
}

func (reader *cachedProcessReader) ParentPID(pid int) (int, error) {
	reader.reads++

	if pid == reader.ownPID {
		return 0, nil
	}

	return reader.ownPID, nil
}

func TestSmartdSnapshotCache(t *testing.T) {
	firstNow := time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)
	clock := &testClock{now: firstNow}
	reader := &cachedProcessReader{ownPID: os.Getpid(), childPID: os.Getpid() + 1, checked: make(chan struct{})}
	controller := New(Dependencies{Clock: clock, ProcessReader: reader})
	serviceContext, cancelService := context.WithCancel(context.Background())
	runDone := make(chan struct{})

	go func() {
		controller.Run(serviceContext)
		close(runDone)
	}()

	closeContext, cancelClose := context.WithTimeout(context.Background(), 50*time.Millisecond)

	defer func() {
		cancelService()

		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 50*time.Millisecond)

		defer cancelCleanup()

		_ = controller.Close(cleanupContext)

		cancelClose()
	}()

	select {
	case <-reader.checked:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("startup diagnostics did not read the process view")
	}

	var first model.Snapshot
	deadline := time.After(50 * time.Millisecond)

	for {
		first = controller.Snapshot()

		if first.Diagnostics.Smartd.Status == model.SmartdNotDetected {
			break
		}

		select {
		case <-deadline:
			t.Fatal("startup diagnostics result was not published")
		default:
			runtime.Gosched()
		}
	}

	readsAfterCheck := reader.reads

	if readsAfterCheck == 0 {
		t.Fatal("startup diagnostics did not read the process view")
	}

	clock.Advance(time.Minute)

	second := controller.Snapshot()

	if reader.reads != readsAfterCheck {
		t.Fatalf("snapshot process reads = %d, want unchanged at %d", reader.reads, readsAfterCheck)
	}

	if first.Diagnostics.CheckedAt != second.Diagnostics.CheckedAt || second.Diagnostics.CheckedAt != "2026-11-24T12:00:00Z" {
		t.Fatalf("cached diagnostic timestamps = %q, %q", first.Diagnostics.CheckedAt, second.Diagnostics.CheckedAt)
	}

	if second.Diagnostics.Smartd.Status != model.SmartdNotDetected {
		t.Fatalf("smartd status = %q, want not-detected for helper-only tree", second.Diagnostics.Smartd.Status)
	}

	if second.Diagnostics.EUID != uint32(os.Geteuid()) || second.Diagnostics.EGID != uint32(os.Getegid()) {
		t.Fatalf("cached process identity = uid %d gid %d", second.Diagnostics.EUID, second.Diagnostics.EGID)
	}

	if err := controller.Close(closeContext); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	select {
	case <-runDone:
	case <-time.After(50 * time.Millisecond):
		t.Fatal("controller Run() did not stop")
	}
}
