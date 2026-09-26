package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"mndwd/internal/authz"
	"mndwd/internal/palette"
	"mndwd/internal/state"
)

func TestEventAssemblyPublishesHookAndInternalEvents(t *testing.T) {
	cfg := frontDoorTestConfig(t, "", "http://127.0.0.1:80")
	cfg.RRDDir = filepath.Join(cfg.DataDir, "rrd")

	if err := os.MkdirAll(cfg.UserPluginsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatal(err)
	}

	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	verifier := authz.New(cfg.DeviceURL, cfg.Dev, logger, authz.Options{})
	c, err := assemble(cfg, store, paletteStore, verifier, logger, context.Background())
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}

	t.Cleanup(func() { _ = c.Close() })

	if err := c.events.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer c.events.Stop("shutdown")

	server := newFrontDoorIPv4Server(c.handler)

	defer server.Close()

	connection, _, err := websocket.Dial(context.Background(), "ws"+server.URL[4:]+"/ws/events", nil)
	if err != nil {
		t.Fatal(err)
	}

	defer connection.Close(websocket.StatusNormalClosure, "")

	writeJSON := func(value any) {
		t.Helper()

		encoded, encodeErr := json.Marshal(value)

		if encodeErr != nil {
			t.Fatal(encodeErr)
		}

		if writeErr := connection.Write(context.Background(), websocket.MessageText, encoded); writeErr != nil {
			t.Fatal(writeErr)
		}
	}

	readMessage := func() []byte {
		t.Helper()

		readContext, cancel := context.WithTimeout(context.Background(), time.Second)

		defer cancel()

		_, message, readErr := connection.Read(readContext)

		if readErr != nil {
			t.Fatal(readErr)
		}

		return message
	}

	writeJSON(map[string]any{"type": "subscribe", "topics": []string{"*"}})
	writeJSON(map[string]any{"type": "replay", "after": "", "limit": 100})

	var replay struct {
		Type   string `json:"type"`
		Events []struct {
			Topic string `json:"topic"`
		} `json:"events"`
	}

	if err := json.Unmarshal(readMessage(), &replay); err != nil {
		t.Fatal(err)
	}

	if replay.Type != "replay" || len(replay.Events) != 1 || replay.Events[0].Topic != "daemon.started" {
		t.Fatalf("startup replay = %#v", replay)
	}

	writeJSON(map[string]any{"type": "subscribe", "topics": []string{"wan"}})

	request, err := http.NewRequest(http.MethodPost, server.URL+"/_internal/hook", strings.NewReader(`{"hook":"wan.d","action":"start","payload":{"interface":"ppp0","address":"192.0.2.10","mask":"255.255.255.0","gateway":"192.0.2.1"}}`))
	if err != nil {
		t.Fatal(err)
	}

	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	response.Body.Close()

	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("hook response = %d, want %d", response.StatusCode, http.StatusNoContent)
	}

	var hook struct {
		Type  string `json:"type"`
		Event struct {
			Topic string `json:"topic"`
		} `json:"event"`
	}

	if err := json.Unmarshal(readMessage(), &hook); err != nil {
		t.Fatal(err)
	}

	if hook.Type != "event" || hook.Event.Topic != "wan.connected" {
		t.Fatalf("hook event = %#v", hook)
	}
}
