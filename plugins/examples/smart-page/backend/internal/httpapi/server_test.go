package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"smart-page/internal/model"
	"smart-page/internal/monitor"
)

type httpTestClock struct {
	now time.Time
}

func (clock *httpTestClock) Now() time.Time {
	return clock.now
}

func (clock *httpTestClock) After(duration time.Duration) <-chan time.Time {
	result := make(chan time.Time, 1)
	result <- clock.now.Add(duration)

	return result
}

func TestReadinessEcho(t *testing.T) {
	handler := New(monitor.New(monitor.Dependencies{}), "smart-page", 1)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/_mndw/ready", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("readiness status = %d, want %d", response.Code, http.StatusOK)
	}

	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("readiness content type = %q, want application/json", response.Header().Get("Content-Type"))
	}

	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness cache control = %q, want no-store", response.Header().Get("Cache-Control"))
	}

	var ready struct {
		PluginID        string `json:"pluginId"`
		ProtocolVersion int    `json:"protocolVersion"`
	}

	if err := json.Unmarshal(response.Body.Bytes(), &ready); err != nil {
		t.Fatalf("decode readiness: %v", err)
	}

	if ready.PluginID != "smart-page" || ready.ProtocolVersion != 1 {
		t.Fatalf("readiness body = %+v, want smart-page protocol 1", ready)
	}
}

func TestSnapshotReturnsEmptyCachedContract(t *testing.T) {
	firstNow := time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)
	clock := &httpTestClock{now: firstNow}
	controller := monitor.New(monitor.Dependencies{Clock: clock})
	handler := New(controller, "smart-page", 1)

	first := httptest.NewRecorder()

	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	if first.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, want %d", first.Code, http.StatusOK)
	}

	if first.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("snapshot content type = %q, want application/json", first.Header().Get("Content-Type"))
	}

	if first.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("snapshot cache control = %q, want no-store", first.Header().Get("Cache-Control"))
	}

	if first.Body.Len() > model.MaxSnapshotBytes {
		t.Fatalf("snapshot size = %d, exceeds %d bytes", first.Body.Len(), model.MaxSnapshotBytes)
	}

	encoded, err := EncodeSnapshot(controller.Snapshot())
	if err != nil {
		t.Fatalf("encode controller snapshot: %v", err)
	}

	if !bytes.Equal(first.Body.Bytes(), encoded) {
		t.Fatal("GET /snapshot body differs from EncodeSnapshot output")
	}

	var snapshot model.Snapshot

	if err := json.Unmarshal(first.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}

	if snapshot.SchemaVersion != 1 || snapshot.ServerNow != model.DateTime(firstNow.Format(time.RFC3339)) {
		t.Fatalf("snapshot envelope = version %d at %q", snapshot.SchemaVersion, snapshot.ServerNow)
	}

	if snapshot.ClockStatus != model.ClockValid || len(snapshot.Devices) != 0 {
		t.Fatalf("snapshot state = clock %q, devices %d; want valid and empty", snapshot.ClockStatus, len(snapshot.Devices))
	}

	if snapshot.Devices == nil || snapshot.Diagnostics.Reasons == nil || len(snapshot.Diagnostics.Reasons) != 1 || snapshot.Diagnostics.Reasons[0] != "discovery-not-run" {
		t.Fatalf("snapshot empty state = devices %#v, diagnostic reasons %#v", snapshot.Devices, snapshot.Diagnostics.Reasons)
	}

	if snapshot.Diagnostics.Utility.Available || snapshot.Diagnostics.Utility.Path != nil || snapshot.Diagnostics.Utility.Version != nil {
		t.Fatalf("snapshot utility diagnostic = %+v, want unavailable and null path/version", snapshot.Diagnostics.Utility)
	}

	if snapshot.Truncated || snapshot.DisconnectedTruncated {
		t.Fatalf("snapshot truncation = (%t, %t), want both false", snapshot.Truncated, snapshot.DisconnectedTruncated)
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(first.Body.Bytes(), &fields); err != nil {
		t.Fatalf("decode snapshot fields: %v", err)
	}

	for _, field := range []string{"config", "persistence"} {
		value, ok := fields[field]

		if !ok || string(value) != "null" {
			t.Errorf("snapshot %s = %s, want explicit null", field, value)
		}
	}

	clock.now = firstNow.Add(time.Minute)
	second := httptest.NewRecorder()

	handler.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	var next model.Snapshot

	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil {
		t.Fatalf("decode second snapshot: %v", err)
	}

	if next.ServerNow != model.DateTime(clock.now.Format(time.RFC3339)) || next.Diagnostics.CheckedAt != model.DateTime(firstNow.Format(time.RFC3339)) {
		t.Fatalf("second snapshot times = serverNow %q, diagnostics.checkedAt %q", next.ServerNow, next.Diagnostics.CheckedAt)
	}
}

func TestSnapshotReadsOnlyCache(t *testing.T) {
	executor := &snapshotReadGuardExecutor{}
	processReader := &snapshotReadGuardProcessReader{}
	registry := snapshotTestRegistry()

	if err := registry.Discover(snapshotScan("/dev/cached"), emptySnapshotScan()); err != nil {
		t.Fatalf("discover cached device: %v", err)
	}

	beforeIDs, _ := registry.CurrentIDs()

	if len(beforeIDs) != 1 {
		t.Fatalf("cached device count = %d, want 1", len(beforeIDs))
	}

	controller := monitor.New(monitor.Dependencies{
		Executor:      executor,
		ProcessReader: processReader,
		Registry:      registry,
	})
	handler := New(controller, "smart-page", 1)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/snapshot", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, want %d", response.Code, http.StatusOK)
	}

	var snapshot model.Snapshot

	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}

	if len(snapshot.Devices) != 1 || snapshot.Devices[0].DeviceID != beforeIDs[0] {
		t.Fatalf("snapshot devices = %+v, want cached device %q", snapshot.Devices, beforeIDs[0])
	}

	afterIDs, _ := registry.CurrentIDs()

	if len(afterIDs) != len(beforeIDs) || afterIDs[0] != beforeIDs[0] {
		t.Fatalf("cached registry IDs after GET = %v, want %v", afterIDs, beforeIDs)
	}

	if executor.calls != 0 {
		t.Fatalf("snapshot executor calls = %d, want 0", executor.calls)
	}

	if processReader.calls != 0 {
		t.Fatalf("snapshot process-reader calls = %d, want 0", processReader.calls)
	}
}

type snapshotReadGuardExecutor struct {
	calls int
}

func (executor *snapshotReadGuardExecutor) Run(context.Context, model.Command) model.CommandResult {
	executor.calls++

	return model.CommandResult{}
}

func (executor *snapshotReadGuardExecutor) Scan(context.Context) model.CommandResult {
	executor.calls++

	return model.CommandResult{}
}

func (executor *snapshotReadGuardExecutor) ScanSCSI(context.Context) model.CommandResult {
	executor.calls++

	return model.CommandResult{}
}

type snapshotReadGuardProcessReader struct {
	calls int
}

func (reader *snapshotReadGuardProcessReader) ListPIDs() ([]int, error) {
	reader.calls++

	return nil, nil
}

func (reader *snapshotReadGuardProcessReader) Comm(int) (string, error) {
	reader.calls++

	return "", nil
}

func (reader *snapshotReadGuardProcessReader) ParentPID(int) (int, error) {
	reader.calls++

	return 0, nil
}
