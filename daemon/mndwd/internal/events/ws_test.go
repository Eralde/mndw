package events

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWebSocketSubscribeReceivesMatchingEvent(t *testing.T) {
	bus := NewBus()
	server := newWebSocketTestServer(t, NewWebSocketHandler(bus, func(*http.Request) bool { return true }))

	defer server.Close()

	connection, _, err := websocket.Dial(context.Background(), "ws"+server.URL[4:], nil)
	if err != nil {
		t.Fatal(err)
	}

	defer connection.Close(websocket.StatusNormalClosure, "")

	if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"type":"subscribe","topics":["net"]}`)); err != nil {
		t.Fatal(err)
	}

	waitForSubscriber(t, bus)
	bus.Publish(testEvent("01J5KZ00000000000000000001", "net.dns_changed"))

	_, message, err := connection.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	var response struct {
		Type  string `json:"type"`
		Event Event  `json:"event"`
	}

	if err := json.Unmarshal(message, &response); err != nil {
		t.Fatal(err)
	}

	if response.Type != "event" || response.Event.Topic != "net.dns_changed" {
		t.Fatalf("response = %#v", response)
	}
}

func TestWebSocketReplayPaginatesRetainedSnapshot(t *testing.T) {
	bus := NewBus()

	for index, topic := range []string{"net.dns_changed", "net.dhcp_lease", "net.dns_changed"} {
		bus.Publish(testEvent("01J5KZ0000000000000000000"+string(rune('1'+index)), topic))
	}

	server := newWebSocketTestServer(t, NewWebSocketHandler(bus, func(*http.Request) bool { return true }))

	defer server.Close()

	connection, _, err := websocket.Dial(context.Background(), "ws"+server.URL[4:], nil)
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
	readReplay := func() (events []Event, hasMore bool) {
		t.Helper()

		_, message, readErr := connection.Read(context.Background())

		if readErr != nil {
			t.Fatal(readErr)
		}

		var response struct {
			Type    string  `json:"type"`
			Events  []Event `json:"events"`
			HasMore bool    `json:"hasMore"`
		}

		if unmarshalErr := json.Unmarshal(message, &response); unmarshalErr != nil {
			t.Fatal(unmarshalErr)
		}

		if response.Type != "replay" {
			t.Fatalf("response type = %q", response.Type)
		}

		return response.Events, response.HasMore
	}

	writeJSON(map[string]any{"type": "subscribe", "topics": []string{"net"}})
	waitForSubscriber(t, bus)
	writeJSON(map[string]any{"type": "replay", "after": "", "limit": 1})

	first, hasMore := readReplay()

	if len(first) != 1 || !hasMore {
		t.Fatalf("first replay = %#v, hasMore=%v", first, hasMore)
	}

	writeJSON(map[string]any{"type": "replay", "after": first[0].ID, "limit": 1})

	second, hasMore := readReplay()

	if len(second) != 1 || !hasMore {
		t.Fatalf("second replay = %#v, hasMore=%v", second, hasMore)
	}

	writeJSON(map[string]any{"type": "replay", "after": second[0].ID, "limit": 1})

	third, hasMore := readReplay()

	if len(third) != 1 || hasMore {
		t.Fatalf("third replay = %#v, hasMore=%v", third, hasMore)
	}
}

func TestWebSocketInvalidSubscriptionPreservesPreviousFilter(t *testing.T) {
	bus := NewBus()
	server := newWebSocketTestServer(t, NewWebSocketHandler(bus, func(*http.Request) bool { return true }))

	defer server.Close()

	connection, _, err := websocket.Dial(context.Background(), "ws"+server.URL[4:], nil)
	if err != nil {
		t.Fatal(err)
	}

	defer connection.Close(websocket.StatusNormalClosure, "")

	write := func(message string) {
		t.Helper()

		if writeErr := connection.Write(context.Background(), websocket.MessageText, []byte(message)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}

	write(`{"type":"subscribe","topics":["net"]}`)
	waitForSubscriber(t, bus)
	write(`{"type":"subscribe","topics":[""]}`)

	_, errorMessage, err := connection.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if string(errorMessage) == "" {
		t.Fatal("empty error message")
	}

	bus.Publish(testEvent("01J5KZ00000000000000000002", "net.dns_changed"))

	readContext, cancel := context.WithTimeout(context.Background(), time.Second)

	defer cancel()

	_, eventMessage, err := connection.Read(readContext)
	if err != nil {
		t.Fatal(err)
	}

	if string(eventMessage) == "" {
		t.Fatal("empty event message")
	}
}

func waitForSubscriber(t *testing.T, bus *Bus) {
	t.Helper()

	select {
	case <-bus.subscriberReadyForTest():
	case <-time.After(time.Second):
		t.Fatal("WebSocket subscriber was not installed")
	}
}

func newWebSocketTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener

	server.Start()

	return server
}
