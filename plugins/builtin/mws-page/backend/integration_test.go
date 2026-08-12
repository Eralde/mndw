package main_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"mws-page/internal/config"
	"mws-page/internal/persistent"
	"mws-page/internal/service"
)

type integrationPersistentSource struct {
	sessions    []persistent.Session
	diagnostics persistent.Diagnostics
}

func (source integrationPersistentSource) Run(context.Context) {}

func (source integrationPersistentSource) Snapshot() []persistent.Session {
	return append([]persistent.Session(nil), source.sessions...)
}

func (source integrationPersistentSource) Diagnostics() persistent.Diagnostics {
	return source.diagnostics
}

func TestPersistentNodesResponseContract(t *testing.T) {
	lastTargetsAt := time.Date(2026, time.August, 12, 10, 0, 0, 0, time.UTC)
	backend := service.New(config.Config{})

	backend.SetPersistentSource(integrationPersistentSource{
		sessions: []persistent.Session{
			{Mac: "aa:bb:cc:dd:ee:ff", Live: true},
			{Mac: "11:22:33:44:55:66", Live: false},
		},
		diagnostics: persistent.Diagnostics{LastTargetsAt: &lastTargetsAt},
	})

	result, err := backend.Nodes(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]json.RawMessage

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	if len(envelope) != 3 {
		t.Fatalf("envelope keys = %#v, want exactly three fields", envelope)
	}

	for _, key := range []string{"lastRefreshAt", "persistentAvailable", "persistentSessions"} {
		if _, ok := envelope[key]; !ok {
			t.Fatalf("missing envelope field %q", key)
		}
	}

	for _, key := range []string{"credState", "nodes"} {
		if _, ok := envelope[key]; ok {
			t.Fatalf("obsolete envelope field %q present", key)
		}
	}

	if string(envelope["persistentAvailable"]) != "true" {
		t.Fatalf("persistentAvailable = %s", envelope["persistentAvailable"])
	}

	var sessions []map[string]any

	if err := json.Unmarshal(envelope["persistentSessions"], &sessions); err != nil {
		t.Fatal(err)
	}

	if len(sessions) != 2 || sessions[0]["mac"] != "aa:bb:cc:dd:ee:ff" || sessions[0]["live"] != true || sessions[1]["live"] != false {
		t.Fatalf("persistentSessions = %#v", sessions)
	}
}

func TestPersistentNodesResponseMarksMissingSourceUnavailable(t *testing.T) {
	result, err := service.New(config.Config{}).Nodes(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var envelope map[string]json.RawMessage

	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}

	if string(envelope["persistentAvailable"]) != "false" || string(envelope["persistentSessions"]) != "[]" {
		t.Fatalf("unavailable envelope = %s", encoded)
	}
}
