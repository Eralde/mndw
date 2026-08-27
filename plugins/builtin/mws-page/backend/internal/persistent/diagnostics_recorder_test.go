package persistent

import (
	"sync"
	"testing"
	"time"
)

func TestDiagnosticsRecorderConnectAndReconnect(t *testing.T) {
	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	d := newDiagnosticsRecorder(&mu, func() time.Time { return fixed }, Diagnostics{})

	mu.Lock()
	d.recordConnectionAttemptLocked()
	d.recordConnectedLocked()
	d.recordDisconnectedLocked("connection-reset")
	d.recordConnectedLocked()

	got := d.snapshotLocked()

	mu.Unlock()

	if got.ConnectionAttempts != 1 {
		t.Fatalf("ConnectionAttempts = %d, want 1", got.ConnectionAttempts)
	}

	if got.ReconnectCount != 1 {
		t.Fatalf("ReconnectCount = %d, want 1 after second connect", got.ReconnectCount)
	}

	if !got.Connected {
		t.Fatal("Connected = false, want true after reconnect")
	}

	if got.LastConnectedAt == nil || !got.LastConnectedAt.Equal(fixed) {
		t.Fatalf("LastConnectedAt = %v, want %v", got.LastConnectedAt, fixed)
	}
}

func TestRecordTelemetryPhaseStampsInjectedClock(t *testing.T) {
	fixed := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	d := newDiagnosticsRecorder(&mu, func() time.Time { return fixed }, Diagnostics{})

	mu.Lock()
	d.recordTelemetryPhaseLocked("cid-1", "system", 200, nil)

	got := d.snapshotLocked()

	mu.Unlock()

	if len(got.Targets) != 1 {
		t.Fatalf("targets = %d, want 1", len(got.Targets))
	}

	if at := got.Targets[0].Telemetry.System.LastSuccessAt; at == nil || !at.Equal(fixed) {
		t.Fatalf("System.LastSuccessAt = %v, want %v", at, fixed)
	}
}
