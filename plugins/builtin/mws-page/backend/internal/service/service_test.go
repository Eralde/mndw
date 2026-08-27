package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	rci "mndw.local/rci"
	"mws-page/internal/config"
	"mws-page/internal/persistent"
	"mws-page/internal/telemetry"
)

type fakePersistentSource struct {
	sessions    []persistent.Session
	diagnostics persistent.Diagnostics
}

func (f fakePersistentSource) Run(context.Context) {}
func (f fakePersistentSource) Snapshot() []persistent.Session {
	return append([]persistent.Session(nil), f.sessions...)
}
func (f fakePersistentSource) Diagnostics() persistent.Diagnostics { return f.diagnostics }

type testClock struct{ now time.Time }

func (c testClock) Now() time.Time { return c.now }

type persistentRequester struct {
	mu        sync.Mutex
	requests  []persistent.Request
	responses []persistent.Response
}

type batchPersistentRequester struct {
	requests []persistent.Request
	response persistent.Response
	err      error
}

func (r *batchPersistentRequester) Do(_ context.Context, request persistent.Request) (persistent.Response, error) {
	r.requests = append(r.requests, request)

	return r.response, r.err
}

type telemetryPhaseCall struct {
	phase  string
	status int
	err    error
}

type recordingPersistentSource struct {
	calls []telemetryPhaseCall
}

func (r *recordingPersistentSource) Run(context.Context) {}

func (r *recordingPersistentSource) Snapshot() []persistent.Session { return nil }

func (r *recordingPersistentSource) Diagnostics() persistent.Diagnostics {
	return persistent.Diagnostics{}
}

func (r *recordingPersistentSource) RecordTelemetryPhase(_ string, phase string, status int, err error) {
	r.calls = append(r.calls, telemetryPhaseCall{phase: phase, status: status, err: err})
}

func (r *persistentRequester) Do(_ context.Context, request persistent.Request) (persistent.Response, error) {
	r.mu.Lock()

	r.requests = append(r.requests, request)

	r.mu.Unlock()

	if strings.Contains(string(request.Body), `"cpu"`) {
		return r.responses[1], nil
	}

	if strings.Contains(string(request.Body), `"memory"`) {
		return r.responses[2], nil
	}

	return r.responses[0], nil
}

func TestNodesResponseUsesPersistentEnvelopeWithoutSource(t *testing.T) {
	service := New(config.Config{})

	response, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]json.RawMessage

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	if _, ok := envelope["credState"]; ok {
		t.Fatal("response still carries credState")
	}

	if _, ok := envelope["nodes"]; ok {
		t.Fatal("response still carries nodes")
	}

	if got := string(envelope["persistentAvailable"]); got != "false" {
		t.Fatalf("persistentAvailable = %s, want false", got)
	}

	if got := string(envelope["persistentSessions"]); got != "[]" {
		t.Fatalf("persistentSessions = %s, want []", got)
	}

	if got := string(envelope["lastRefreshAt"]); got != "null" {
		t.Fatalf("lastRefreshAt = %s, want null", got)
	}
}

func TestNodesResponseUsesPersistentEnvelopeWithSource(t *testing.T) {
	when := time.Date(2026, time.August, 12, 10, 0, 0, 0, time.UTC)
	service := New(config.Config{})

	service.SetPersistentSource(fakePersistentSource{
		sessions:    []persistent.Session{{Mac: "aa:bb:cc:dd:ee:ff", Live: true}},
		diagnostics: persistent.Diagnostics{LastTargetsAt: &when, TargetCount: 2, SessionCount: 1},
	})

	response, err := service.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]json.RawMessage

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	if got := string(envelope["persistentAvailable"]); got != "true" {
		t.Fatalf("persistentAvailable = %s, want true", got)
	}

	if got := string(envelope["persistentSessions"]); got == "[]" {
		t.Fatalf("persistentSessions = %s, want session", got)
	}

	if got := string(envelope["persistentTargetCount"]); got != "2" {
		t.Fatalf("persistentTargetCount = %s, want 2", got)
	}

	if got := string(envelope["persistentSessionCount"]); got != "1" {
		t.Fatalf("persistentSessionCount = %s, want 1", got)
	}

	if got := string(envelope["lastRefreshAt"]); got != `"2026-08-12T10:00:00Z"` {
		t.Fatalf("lastRefreshAt = %s", got)
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

	if envelope["persistentAvailable"] != true {
		t.Fatalf("persistentAvailable = %#v, want true", envelope["persistentAvailable"])
	}

	sessions, ok := envelope["persistentSessions"].([]any)

	if !ok || len(sessions) != 2 {
		t.Fatalf("persistentSessions = %#v, want two entries", envelope["persistentSessions"])
	}
}

func TestNodesResponseIncludesPersistentRadioPower(t *testing.T) {
	value := 75
	service := New(config.Config{})

	service.SetPersistentSource(fakePersistentSource{sessions: []persistent.Session{{
		Mac:     "aa:bb:cc:dd:ee:ff",
		Live:    true,
		Power2G: persistent.PowerState{Value: &value, Available: true},
		Power5G: persistent.PowerState{Value: &value, Available: false},
	}}})

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

	sessions := envelope["persistentSessions"].([]any)
	session := sessions[0].(map[string]any)
	power2G := session["power2g"].(map[string]any)
	power5G := session["power5g"].(map[string]any)

	if power2G["value"] != float64(75) || power2G["available"] != true {
		t.Fatalf("2.4 GHz power = %#v", power2G)
	}

	if power5G["value"] != float64(75) || power5G["available"] != false {
		t.Fatalf("5 GHz power = %#v", power5G)
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
	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusOK, Body: []byte(`[
		{"show":{"system":{"uptime":42,"cpuload":27,"memtotal":1000,"memory":"610/1024"}}},
		{"show":{"system":{"rrd":{"cpu":{"data":[{"t":1,"v":27}]}}}}},
		{"show":{"system":{"rrd":{"memory":{"data":[{"t":1,"v":610}]}}}}}
	]`)}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err != nil {
		t.Fatal(err)
	}

	if len(requester.requests) != 1 {
		t.Fatalf("requests = %#v, want one batched request", requester.requests)
	}

	wantQueries := map[string]map[string]any{
		"system": {"show": map[string]any{"system": map[string]any{}}},
		"cpu":    {"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"cpu": map[string]any{"detail": float64(0), "attribute": "avg"}}}}},
		"memory": {"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"memory": map[string]any{"detail": float64(0), "attribute": "used"}}}}},
	}
	request := requester.requests[0]

	if request.Method != http.MethodPost || request.Path != "rci/" {
		t.Fatalf("request = %#v, want POST rci/", request)
	}

	var envelope []map[string]any

	if err := json.Unmarshal(request.Body, &envelope); err != nil {
		t.Fatalf("request body: %v", err)
	}

	if len(envelope) != 3 || !reflect.DeepEqual(envelope[0], wantQueries["system"]) || !reflect.DeepEqual(envelope[1], wantQueries["cpu"]) || !reflect.DeepEqual(envelope[2], wantQueries["memory"]) {
		t.Fatalf("batched query = %#v, want system/cpu/memory queries", envelope)
	}

	if sample, ok := service.telemetry.Persistent("cid-1", time.Now()); !ok || sample.System.CPULoad != 27 || len(sample.CPURRD.Data) != 1 || len(sample.MemoryRRD.Data) != 1 {
		t.Fatalf("stored sample = %#v, ok = %v", sample, ok)
	}
}

func TestPersistentTelemetryPollUsesSingleRequest(t *testing.T) {
	service := New(config.Config{})
	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusServiceUnavailable}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err == nil {
		t.Fatal("poll error = nil, want request failure")
	}

	if len(requester.requests) != 1 {
		t.Fatalf("requests = %d, want one batched request", len(requester.requests))
	}
}

func TestPersistentTelemetryDiagnosticsTrackEachPhase(t *testing.T) {
	client := persistent.New(persistent.Config{PluginID: "mws-page"})
	service := New(config.Config{})

	service.SetPersistentSource(client)

	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusServiceUnavailable}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err == nil {
		t.Fatal("poll error = nil, want partial telemetry failure")
	}

	if _, ok := service.telemetry.Persistent("cid-1", time.Now()); ok {
		t.Fatal("partial telemetry was stored")
	}

	diagnostics := client.Diagnostics()

	if len(diagnostics.Targets) != 1 {
		t.Fatalf("target diagnostics = %#v, want one target", diagnostics.Targets)
	}

	phase := diagnostics.Targets[0].Telemetry

	if phase.CPURRD.LastError == nil || phase.CPURRD.LastAttemptAt == nil || phase.MemoryRRD.LastError == nil || phase.MemoryRRD.LastAttemptAt == nil {
		t.Fatalf("telemetry phase diagnostics = %#v", phase)
	}
}

func TestPersistentTelemetryParseFailureRecordsFourPhases(t *testing.T) {
	recorder := &recordingPersistentSource{}
	service := New(config.Config{})

	service.SetPersistentSource(recorder)

	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusOK, Body: []byte(`[
		{"show":{"system":{"uptime":42,"cpuload":27,"memtotal":1000,"memory":"610/1024"}}},
		{"show":{"system":{"rrd":{"cpu":"malformed"}}}},
		{"show":{"system":{"rrd":{"memory":{"data":[]}}}}}
	]`)}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err == nil {
		t.Fatal("poll error = nil, want parse failure")
	}

	if len(recorder.calls) != 4 {
		t.Fatalf("telemetry phase calls = %#v, want three request phases plus system parse phase", recorder.calls)
	}

	wantPhases := []string{"system", "cpuRrd", "memoryRrd", "system"}

	for index, want := range wantPhases {
		if recorder.calls[index].phase != want || recorder.calls[index].status != http.StatusOK {
			t.Fatalf("phase call %d = %#v, want phase %q and status 200", index, recorder.calls[index], want)
		}
	}

	if recorder.calls[0].err != nil || recorder.calls[1].err != nil || recorder.calls[2].err != nil || recorder.calls[3].err == nil {
		t.Fatalf("phase errors = %#v, want request successes and system parse error", recorder.calls)
	}
}

func TestPersistentTelemetryDeadlineErrorIsPreserved(t *testing.T) {
	service := New(config.Config{})
	requester := &batchPersistentRequester{err: context.DeadlineExceeded}

	err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("poll error = %v, want context.DeadlineExceeded", err)
	}
}

func TestPersistentTelemetryAbsentPathUsesEmptyPhase(t *testing.T) {
	recorder := &recordingPersistentSource{}
	service := New(config.Config{})

	service.SetPersistentSource(recorder)

	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusOK, Body: []byte(`[
		{"show":{"system":{"uptime":42,"cpuload":27,"memtotal":1000,"memory":"610/1024"}}},
		{"show":{"system":{"rrd":{"memory":{"data":[]}}}}},
		{"show":{"system":{"rrd":{"memory":{"data":[]}}}}}
	]`)}}

	err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester)
	if err == nil || err.Error() != "persistent cpuRrd telemetry response empty" {
		t.Fatalf("poll error = %v, want cpuRrd empty error", err)
	}

	if len(recorder.calls) != 3 {
		t.Fatalf("telemetry phase calls = %#v, want three request phases", recorder.calls)
	}
}

func TestPersistentTelemetryEmptyAndMalformedBodiesAreInvalidResponses(t *testing.T) {
	for _, test := range []struct {
		name string
		body []byte
	}{
		{name: "empty", body: nil},
		{name: "malformed", body: []byte(`{"not":"a command result array"}`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := &recordingPersistentSource{}
			service := New(config.Config{})

			service.SetPersistentSource(recorder)

			requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusOK, Body: test.body}}

			err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester)
			if !errors.Is(err, rci.ErrInvalidResponse) {
				t.Fatalf("poll error = %v, want rci.ErrInvalidResponse", err)
			}

			if len(recorder.calls) != 3 {
				t.Fatalf("telemetry phase calls = %#v, want three request phases", recorder.calls)
			}
		})
	}
}

func TestPersistentTelemetryPreservesLargeMemtotal(t *testing.T) {
	service := New(config.Config{})
	requester := &batchPersistentRequester{response: persistent.Response{Status: http.StatusOK, Body: []byte(`[
		{"show":{"system":{"uptime":42,"cpuload":27,"memtotal":9007199254740993,"memory":"610/1024"}}},
		{"show":{"system":{"rrd":{"cpu":{"data":[]}}}}},
		{"show":{"system":{"rrd":{"memory":{"data":[]}}}}}
	]`)}}

	if err := service.pollPersistentTelemetry(context.Background(), persistent.Target{Identity: "cid-1"}, requester); err != nil {
		t.Fatal(err)
	}

	sample, ok := service.telemetry.Persistent("cid-1", time.Now())

	if !ok || sample.System.MemTotal != 9007199254740993 {
		t.Fatalf("sample = %#v, ok = %v, want exact memtotal", sample, ok)
	}
}

func TestDiagnosticsSnapshotIncludesPersistentConfiguration(t *testing.T) {
	t.Setenv("MNDW_RCI_SESSION_SOCKET", "/run/mws-page/rci-session.sock")

	service := New(config.Config{})
	snapshot := service.DiagnosticsSnapshot()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]any

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	state, ok := envelope["persistent"].(map[string]any)

	if !ok {
		t.Fatalf("persistent diagnostics = %#v", envelope["persistent"])
	}

	if state["pollInterval"] != "5s" || state["ioTimeout"] != "5s" || state["telemetryPollEnabled"] != true {
		t.Fatalf("persistent configuration = %#v", state)
	}

	for _, field := range []string{"lastTargetsAt", "lastTelemetryAt", "lastError"} {
		if value, present := state[field]; !present || value != nil {
			t.Fatalf("persistent %s = %#v, present = %v; want null", field, value, present)
		}
	}
}

func TestDiagnosticsSnapshotIncludesLocalStateAndBoundsRrdData(t *testing.T) {
	service := New(config.Config{})
	when := time.Date(2026, time.August, 4, 15, 30, 0, 0, time.UTC)

	service.SetClock(testClock{now: when})
	service.SetPersistentSource(fakePersistentSource{
		sessions:    []persistent.Session{{Identity: "cid-1", Mac: "aa:bb:cc:dd:ee:ff", Live: true}},
		diagnostics: persistent.Diagnostics{LastTargetsAt: &when},
	})

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

	var envelope map[string]any

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	if _, present := envelope["runtime"]; present {
		t.Fatalf("diagnostics leaked runtime identity: %#v", envelope["runtime"])
	}

	if envelope["lastRefreshAt"] != when.Format(time.RFC3339) {
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

func TestDiagnosticsSnapshotIncludesPersistentClientState(t *testing.T) {
	service := New(config.Config{})
	when := time.Date(2026, time.August, 5, 6, 20, 0, 0, time.UTC)

	service.SetPersistentSource(fakePersistentSource{diagnostics: persistent.Diagnostics{
		Configured:      true,
		PluginIDPresent: true,
		SocketPath:      "/run/mws-page/rci-session.sock",
		Connected:       true,
		TargetCount:     1,
		SessionCount:    1,
		LastTargetsAt:   &when,
		LastTelemetryAt: &when,
	}})

	snapshot := service.DiagnosticsSnapshot()
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]any

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	state, ok := envelope["persistent"].(map[string]any)

	if !ok {
		t.Fatalf("persistent diagnostics = %#v", envelope["persistent"])
	}

	if state["configured"] != true || state["pluginIdPresent"] != true || state["socketPath"] != "/run/mws-page/rci-session.sock" || state["connected"] != true || state["targetCount"] != float64(1) || state["sessionCount"] != float64(1) {
		t.Fatalf("persistent diagnostics = %#v", state)
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
