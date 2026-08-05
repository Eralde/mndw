package service

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mws-map-page/internal/config"
	"mws-map-page/internal/discovery"
	"mws-map-page/internal/persistent"
	"mws-map-page/internal/telemetry"
	"mws-map-page/internal/testsupport"
)

type fakePersistentSource struct {
	sessions []persistent.Session
}

func (f fakePersistentSource) Run(context.Context) {}
func (f fakePersistentSource) Snapshot() []persistent.Session {
	return append([]persistent.Session(nil), f.sessions...)
}

type testClock struct{ now time.Time }

func (c testClock) Now() time.Time { return c.now }

type persistentRequester struct {
	requests  []persistent.Request
	responses []persistent.Response
}

func (r *persistentRequester) Do(_ context.Context, request persistent.Request) (persistent.Response, error) {
	r.requests = append(r.requests, request)
	return r.responses[len(r.requests)-1], nil
}

func TestNodesResponseTracksSuccessfulRefreshAndUsesUTC(t *testing.T) {
	controller := testsupport.NewFakeController(t, "admin", "secret", []byte(`[]`))
	service := New(config.Config{ControllerURL: controller.Server.URL})
	when := time.Date(2026, time.August, 3, 19, 42, 10, 0, time.FixedZone("CEST", 2*60*60))
	service.SetClock(testClock{now: when})
	service.holder.SetClock(testClock{now: when})

	if _, err := service.Credentials(context.Background(), "admin", "secret"); err != nil {
		t.Fatalf("Credentials: %v", err)
	}

	response, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(encoded); got != `{"credState":"present","lastRefreshAt":"2026-08-03T17:42:10Z","nodes":[]}` {
		t.Fatalf("response = %s", got)
	}
}

func TestNodesResponsePreservesRefreshTimestampAfterFailedRefresh(t *testing.T) {
	controller := testsupport.NewFakeController(t, "admin", "secret", []byte(`[]`))
	service := New(config.Config{ControllerURL: controller.Server.URL})
	when := time.Unix(100, 0).UTC()
	service.SetClock(testClock{now: when})
	service.holder.SetClock(testClock{now: when})

	if _, err := service.Credentials(context.Background(), "admin", "secret"); err != nil {
		t.Fatalf("Credentials: %v", err)
	}
	previous := service.lastRefreshAt
	controller.SetMembers([]byte(`{"not":"members"}`))
	if err := service.refresh(context.Background()); err == nil {
		t.Fatal("refresh error = nil")
	}
	if service.lastRefreshAt.IsZero() || previous.IsZero() || !service.lastRefreshAt.Equal(previous) {
		t.Fatalf("last refresh changed after failed refresh: previous=%v current=%v", previous, service.lastRefreshAt)
	}
}

func TestNodesResponseIncludesPerNodeLastSuccessAndNullBeforeSuccess(t *testing.T) {
	service := New(config.Config{})
	service.credentials.Set("admin", []byte("secret"), 1)
	member := discovery.Member{CID: "cid-1", MAC: "aa:bb:cc:dd:ee:ff", IP: "192.168.1.2", Online: true}
	service.members = []discovery.Member{member}

	withoutSuccess, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes without success: %v", err)
	}
	withoutSuccessJSON, err := json.Marshal(withoutSuccess)
	if err != nil {
		t.Fatal(err)
	}
	var withoutSuccessEnvelope map[string]any
	if err := json.Unmarshal(withoutSuccessJSON, &withoutSuccessEnvelope); err != nil {
		t.Fatal(err)
	}
	if withoutSuccessEnvelope["lastRefreshAt"] != nil {
		t.Fatalf("lastRefreshAt = %v, want null", withoutSuccessEnvelope["lastRefreshAt"])
	}
	nodes, ok := withoutSuccessEnvelope["nodes"].([]any)
	if !ok || len(nodes) != 1 {
		t.Fatalf("nodes = %#v, want one node", withoutSuccessEnvelope["nodes"])
	}
	node, ok := nodes[0].(map[string]any)
	if !ok || node["lastSuccessAt"] != nil {
		t.Fatalf("lastSuccessAt = %#v, want null", node["lastSuccessAt"])
	}

	when := time.Date(2026, time.August, 3, 19, 42, 10, 0, time.FixedZone("CEST", 2*60*60))
	service.holder.State().RecordSuccess(member.Identity(), when)
	withSuccess, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes with success: %v", err)
	}
	withSuccessJSON, err := json.Marshal(withSuccess)
	if err != nil {
		t.Fatal(err)
	}
	if string(withSuccessJSON) == string(withoutSuccessJSON) {
		t.Fatalf("success timestamp did not change response: %s", withSuccessJSON)
	}
	if !containsNodeField(withSuccessJSON, "lastSuccessAt", "2026-08-03T17:42:10Z") {
		t.Fatalf("response with success = %s", withSuccessJSON)
	}
}

func TestNodesResponseIncludesPersistentSessionsWithoutCredentials(t *testing.T) {
	service := New(config.Config{})
	service.SetPersistentSource(fakePersistentSource{sessions: []persistent.Session{{Mac: "aa:bb:cc:dd:ee:ff", Live: true}, {Mac: "11:22:33:44:55:66", Live: false}}})

	response, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["credState"] != "absent" {
		t.Fatalf("credState = %#v, want absent", envelope["credState"])
	}
	sessions, ok := envelope["persistentSessions"].([]any)
	if !ok || len(sessions) != 2 {
		t.Fatalf("persistentSessions = %#v, want two entries", envelope["persistentSessions"])
	}
}

func TestNodesResponseIncludesPersistentTelemetryWithoutCredentials(t *testing.T) {
	service := New(config.Config{})
	when := time.Unix(100, 0).UTC()
	service.SetClock(testClock{now: when})
	service.telemetry.StorePersistent("cid-1", telemetry.PersistentTelemetry{
		SampledAt: when,
		System:    telemetry.System{CPULoad: 27},
	})
	service.SetPersistentSource(fakePersistentSource{sessions: []persistent.Session{{Identity: "cid-1", Mac: "aa:bb:cc:dd:ee:ff", Live: true}}})

	response, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	sessions, ok := envelope["persistentSessions"].([]any)
	if !ok || len(sessions) != 1 {
		t.Fatalf("persistentSessions = %#v", envelope["persistentSessions"])
	}
	session, ok := sessions[0].(map[string]any)
	if !ok {
		t.Fatalf("session = %#v", sessions[0])
	}
	telemetry, ok := session["telemetry"].(map[string]any)
	if !ok || telemetry["system"].(map[string]any)["cpuload"] != float64(27) {
		t.Fatalf("telemetry = %#v", session["telemetry"])
	}
}

func TestPersistentTelemetryPollUsesDeviceInfoQueries(t *testing.T) {
	service := New(config.Config{})
	requester := &persistentRequester{responses: []persistent.Response{
		{Status: http.StatusOK, Body: []byte(`[ {"show":{"system":{"uptime":42,"cpuload":27,"memtotal":1000,"memory":"610/1024"}}} ]`)},
		{Status: http.StatusOK, Body: []byte(`[ {"show":{"system":{"rrd":{"cpu":{"data":[{"t":1,"v":27}]}}}}} ]`)},
		{Status: http.StatusOK, Body: []byte(`[ {"show":{"system":{"rrd":{"memory":{"data":[{"t":1,"v":610}]}}}}} ]`)},
	}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err != nil {
		t.Fatal(err)
	}
	if len(requester.requests) != 3 {
		t.Fatalf("requests = %#v, want three requests", requester.requests)
	}

	wantQueries := []map[string]any{
		{"show": map[string]any{"system": map[string]any{}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"cpu": map[string]any{"detail": float64(0), "attribute": "avg"}}}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"memory": map[string]any{"detail": float64(0), "attribute": "used"}}}}},
	}
	for index, request := range requester.requests {
		if request.Method != http.MethodPost || request.Path != "rci/" {
			t.Fatalf("request %d = %#v, want POST rci/", index, request)
		}
		var envelope []map[string]any
		if err := json.Unmarshal(request.Body, &envelope); err != nil {
			t.Fatalf("request %d body: %v", index, err)
		}
		if !reflect.DeepEqual(envelope[0], wantQueries[index]) {
			t.Fatalf("request %d query = %#v, want %#v", index, envelope[0], wantQueries[index])
		}
	}
	if sample, ok := service.telemetry.Persistent("cid-1", time.Now()); !ok || sample.System.CPULoad != 27 || len(sample.CPURRD.Data) != 1 || len(sample.MemoryRRD.Data) != 1 {
		t.Fatalf("stored sample = %#v, ok = %v", sample, ok)
	}
}

func TestDiagnosticsSnapshotIncludesLocalStateAndBoundsRrdData(t *testing.T) {
	runtimeDir := t.TempDir()
	service := New(config.Config{RuntimeDir: runtimeDir, SocketName: "mwsd.sock", PIDName: "mwsd.pid"})
	when := time.Date(2026, time.August, 4, 15, 30, 0, 0, time.UTC)
	service.SetClock(testClock{now: when})
	service.credentials.Set("admin", []byte("DO_NOT_EXPORT"), 1)
	service.members = []discovery.Member{{CID: "cid-1", MAC: "aa:bb:cc:dd:ee:ff", IP: "192.168.1.2", Online: true}}
	service.lastRefreshAt = when
	service.SetPersistentSource(fakePersistentSource{sessions: []persistent.Session{{Identity: "cid-1", Mac: "aa:bb:cc:dd:ee:ff", Live: true}}})
	ticks := make([]telemetry.RrdTick, 75)
	for index := range ticks {
		ticks[index] = telemetry.RrdTick{T: json.RawMessage("1"), V: float64(index)}
	}
	service.telemetry.StorePersistent("cid-1", telemetry.PersistentTelemetry{
		SampledAt: when,
		CPURRD:    telemetry.RrdResponse{Data: ticks},
		MemoryRRD: telemetry.RrdResponse{Data: ticks},
	})

	snapshot := service.DiagnosticsSnapshot()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "DO_NOT_EXPORT") {
		t.Fatalf("snapshot contains credential value: %s", encoded)
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	runtime, ok := envelope["runtime"].(map[string]any)
	if !ok || runtime["pid"] != float64(os.Getpid()) || runtime["pidPath"] != filepath.Join(runtimeDir, "mwsd.pid") || runtime["socketPath"] != filepath.Join(runtimeDir, "mwsd.sock") || runtime["socketPresent"] != false {
		t.Fatalf("runtime = %#v", envelope["runtime"])
	}
	if envelope["credState"] != "present" || envelope["lastRefreshAt"] != when.Format(time.RFC3339) {
		t.Fatalf("state = %#v", envelope)
	}
	sessions, ok := envelope["persistentSessions"].([]any)
	if !ok || len(sessions) != 1 {
		t.Fatalf("persistentSessions = %#v", envelope["persistentSessions"])
	}
	session, ok := sessions[0].(map[string]any)
	if !ok {
		t.Fatalf("session = %#v", sessions[0])
	}
	telemetryData, ok := session["telemetry"].(map[string]any)
	if !ok {
		t.Fatalf("telemetry = %#v", session["telemetry"])
	}
	for _, field := range []string{"cpuRrd", "memoryRrd"} {
		series := telemetryData[field].(map[string]any)["data"].([]any)
		if len(series) != 60 || series[0].(map[string]any)["v"] != float64(15) || series[59].(map[string]any)["v"] != float64(74) {
			t.Fatalf("%s = %#v", field, series)
		}
	}
}

func TestDiagnosticsTickWritesWhenCredentialsAbsent(t *testing.T) {
	runtimeDir := t.TempDir()
	service := New(config.Config{RuntimeDir: runtimeDir, SocketName: "mwsd.sock", PIDName: "mwsd.pid"})
	if err := service.writeDiagnosticsTick(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(runtimeDir, "diagnostics.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"credState":"absent"`) {
		t.Fatalf("diagnostics = %s", data)
	}
}

func containsNodeField(data []byte, key, value string) bool {
	var envelope map[string]any
	if json.Unmarshal(data, &envelope) != nil {
		return false
	}
	nodes, ok := envelope["nodes"].([]any)
	if !ok || len(nodes) != 1 {
		return false
	}
	node, ok := nodes[0].(map[string]any)
	if !ok {
		return false
	}

	return node[key] == value
}
