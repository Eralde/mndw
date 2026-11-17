package backend

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type recordedClose struct {
	code   websocket.StatusCode
	reason string
}

type recordingCloser struct {
	mu      sync.Mutex
	closes  []recordedClose
	onClose func()
}

func (c *recordingCloser) Close(code websocket.StatusCode, reason string) error {
	c.mu.Lock()

	c.closes = append(c.closes, recordedClose{code: code, reason: reason})
	onClose := c.onClose

	c.mu.Unlock()

	if onClose != nil {
		onClose()
	}

	return nil
}

func (c *recordingCloser) closeRecords() []recordedClose {
	c.mu.Lock()

	defer c.mu.Unlock()

	return slices.Clone(c.closes)
}

func TestTrafficGateClosePluginClosesOnlyMatching(t *testing.T) {
	gate := NewTrafficGate()
	a1 := &recordingCloser{}
	a2 := &recordingCloser{}
	b1 := &recordingCloser{}

	gate.Track(a1, "a")
	gate.Track(a2, "a")
	gate.Track(b1, "b")
	gate.ClosePlugin("a")

	for name, closer := range map[string]*recordingCloser{"a1": a1, "a2": a2} {
		got := closer.closeRecords()

		if len(got) != 1 || got[0] != (recordedClose{code: websocket.StatusServiceRestart, reason: "mndw updating"}) {
			t.Errorf("%s close records = %#v, want one service-restart close", name, got)
		}
	}

	if got := b1.closeRecords(); len(got) != 0 {
		t.Errorf("b1 close records = %#v, want none", got)
	}
}

func TestTrafficGateRetrackingMovesSocketToLatestPlugin(t *testing.T) {
	gate := NewTrafficGate()
	closer := &recordingCloser{}

	gate.Track(closer, "a")
	gate.Track(closer, "b")

	gate.ClosePlugin("a")

	if got := closer.closeRecords(); len(got) != 0 {
		t.Fatalf("close records after closing previous plugin = %#v, want none", got)
	}

	gate.ClosePlugin("b")

	if got := closer.closeRecords(); len(got) != 1 {
		t.Fatalf("close records after closing current plugin = %#v, want one", got)
	}
}

func TestTrafficGateUntrackStopsClosing(t *testing.T) {
	gate := NewTrafficGate()
	closer := &recordingCloser{}
	untrack, ok := gate.Track(closer, "a")

	if !ok {
		t.Fatal("Track refused a connection outside maintenance")
	}

	untrack()
	untrack()
	gate.ClosePlugin("a")

	if got := closer.closeRecords(); len(got) != 0 {
		t.Fatalf("close records = %#v, want none after untrack", got)
	}
}

func TestTrafficGateSetsFlagBeforeClosing(t *testing.T) {
	gate := NewTrafficGate()
	var observed bool
	closer := &recordingCloser{onClose: func() { observed = gate.PlatformMaintenance() }}

	gate.Track(closer, "a")
	gate.BeginPlatformMaintenance()

	if !observed {
		t.Fatal("close callback observed platform maintenance as false")
	}

	if got := closer.closeRecords(); len(got) != 1 {
		t.Fatalf("close records = %#v, want one close", got)
	}
}

func TestTrafficGateCloseRunsOutsideLock(t *testing.T) {
	gate := NewTrafficGate()
	var untrack func()
	closer := &recordingCloser{onClose: func() { untrack() }}
	var ok bool
	untrack, ok = gate.Track(closer, "a")

	if !ok {
		t.Fatal("Track refused a connection outside maintenance")
	}

	done := make(chan struct{})

	go func() {
		gate.ClosePlugin("a")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ClosePlugin blocked while closer untracked itself")
	}
}

func TestTrafficGateFreshIsNotInMaintenance(t *testing.T) {
	if NewTrafficGate().PlatformMaintenance() {
		t.Fatal("new traffic gate started in platform maintenance")
	}
}

func TestSocketTrackDoesNotCreateLifecycleRecord(t *testing.T) {
	// Tracking a socket creates neither service nor lifecycle presence.
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	closer := &recordingCloser{}

	if _, ok := runtime.Traffic().Track(closer, "socket-only"); !ok {
		t.Fatal("Track refused a socket outside platform maintenance")
	}

	snapshot := runtime.supervisor.pluginSnapshot("socket-only")

	if snapshot.desiredPresent || snapshot.servicePresent || snapshot.transitionPresent {
		t.Fatal("socket tracking created a service or lifecycle record")
	}

	if got := runtime.Status("socket-only").State; got != StateStopped {
		t.Fatalf("socket-only status = %q, want %q", got, StateStopped)
	}

	if path, ok := runtime.SocketPath("socket-only"); ok || path != "" {
		t.Fatalf("socket-only path = %q, %v, want empty and absent", path, ok)
	}
}

func TestSocketOnlyRecordLivesUntilLastUntrack(t *testing.T) {
	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	closer := &recordingCloser{}
	untrack, ok := runtime.Traffic().Track(closer, "socket-only")

	if !ok {
		t.Fatal("Track refused a connection outside platform maintenance")
	}

	if !supervisorPluginRecordPresentForTest(runtime.supervisor, "socket-only") {
		t.Fatal("socket tracking did not retain a plugin record")
	}

	untrack()

	if supervisorPluginRecordPresentForTest(runtime.supervisor, "socket-only") {
		t.Fatal("last untrack retained an otherwise empty plugin record")
	}
}

func TestTrafficGateTrackRefusedDuringPlatformMaintenance(t *testing.T) {
	gate := NewTrafficGate()

	gate.BeginPlatformMaintenance()

	closer := &recordingCloser{}
	untrack, ok := gate.Track(closer, "a")

	if ok {
		t.Fatal("Track accepted a connection during platform maintenance")
	}

	if untrack == nil {
		t.Fatal("Track returned a nil untrack function")
	}

	untrack()
	gate.ClosePlugin("a")

	if got := closer.closeRecords(); len(got) != 0 {
		t.Fatalf("refused connection close records = %#v, want none", got)
	}
}
