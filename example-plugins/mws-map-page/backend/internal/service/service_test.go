package service

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"mws-map-page/internal/config"
	"mws-map-page/internal/discovery"
	"mws-map-page/internal/persistent"
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
