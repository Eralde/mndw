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

func TestWebSocketSubscribeDuringReplayResetsSnapshotAndUpdatesLiveFilter(t *testing.T) {
	bus := NewBus()
	netEvent := testEvent("01J5KZ00000000000000000000", "net.dns_changed")
	pluginReplayEvent := testEvent("01J5KZ00000000000000000001", "plugin.started")
	nextNetEvent := testEvent("01J5KZ00000000000000000002", "net.dhcp_lease")

	for _, event := range []Event{netEvent, pluginReplayEvent, nextNetEvent} {
		bus.Publish(event)
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
	readReplay := func() (events []Event, hasMore bool) {
		t.Helper()

		var response struct {
			Type    string  `json:"type"`
			Events  []Event `json:"events"`
			HasMore bool    `json:"hasMore"`
		}

		if unmarshalErr := json.Unmarshal(readMessage(), &response); unmarshalErr != nil {
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
	if len(first) != 1 || first[0].ID != netEvent.ID || !hasMore {
		t.Fatalf("first replay = %#v, hasMore=%v", first, hasMore)
	}

	writeJSON(map[string]any{"type": "subscribe", "topics": []string{"net", "plugin"}})
	writeJSON(map[string]any{"type": "replay", "after": first[0].ID, "limit": 1})

	second, hasMore := readReplay()
	if len(second) != 1 || second[0].ID != pluginReplayEvent.ID || !hasMore {
		t.Fatalf("replay after updated subscribe = %#v, hasMore=%v", second, hasMore)
	}

	writeJSON(map[string]any{"type": "replay", "after": second[0].ID, "limit": 1})

	third, hasMore := readReplay()
	if len(third) != 1 || third[0].ID != nextNetEvent.ID || hasMore {
		t.Fatalf("next replay = %#v, hasMore=%v", third, hasMore)
	}

	livePluginEvent := testEvent("01J5KZ00000000000000000003", "plugin.started")
	bus.Publish(livePluginEvent)

	var liveResponse struct {
		Type  string `json:"type"`
		Event Event  `json:"event"`
	}

	if unmarshalErr := json.Unmarshal(readMessage(), &liveResponse); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}

	if liveResponse.Type != "event" || liveResponse.Event.ID != livePluginEvent.ID {
		t.Fatalf("live response = %#v", liveResponse)
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

func TestWebSocketResubscribeKeepsQueuedEvent(t *testing.T) {
	bus := NewBus()
	var (
		filter       TopicFilter
		liveEvents   <-chan Event
		subscription *Subscription
		snapshot     *replaySnapshot
	)

	defer func() {
		if subscription != nil {
			subscription.Cancel()
		}
	}()

	allTopics := []string{"*"}

	if !handleClientMessage(nil, bus, clientMessage{Type: "subscribe", Topics: &allTopics}, &filter, &liveEvents, &subscription, &snapshot) {
		t.Fatal("initial subscribe failed")
	}

	initialEvents := liveEvents
	want := testEvent("01J5KZ00000000000000000021", "wan.connected")

	bus.Publish(want)

	wanTopics := []string{"wan"}

	if !handleClientMessage(nil, bus, clientMessage{Type: "subscribe", Topics: &wanTopics}, &filter, &liveEvents, &subscription, &snapshot) {
		t.Fatal("resubscribe failed")
	}

	if liveEvents != initialEvents {
		t.Fatal("resubscribe replaced the channel containing the queued event")
	}

	got := <-liveEvents

	if got.ID != want.ID {
		t.Fatalf("event ID = %q, want %q", got.ID, want.ID)
	}

	select {
	case got := <-liveEvents:
		t.Fatalf("duplicate event: %#v", got)
	default:
	}
}

func TestWebSocketResubscribeDropsEventsOutsideNewFilter(t *testing.T) {
	bus := NewBus()
	var (
		filter       TopicFilter
		liveEvents   <-chan Event
		subscription *Subscription
		snapshot     *replaySnapshot
	)

	defer func() {
		if subscription != nil {
			subscription.Cancel()
		}
	}()

	allTopics := []string{"*"}

	if !handleClientMessage(nil, bus, clientMessage{Type: "subscribe", Topics: &allTopics}, &filter, &liveEvents, &subscription, &snapshot) {
		t.Fatal("initial subscribe failed")
	}

	initialEvents := liveEvents

	bus.Publish(testEvent("01J5KZ00000000000000000022", "system.x"))

	want := testEvent("01J5KZ00000000000000000023", "wan.connected")

	bus.Publish(want)

	wanTopics := []string{"wan"}

	if !handleClientMessage(nil, bus, clientMessage{Type: "subscribe", Topics: &wanTopics}, &filter, &liveEvents, &subscription, &snapshot) {
		t.Fatal("resubscribe failed")
	}

	if liveEvents != initialEvents {
		t.Fatal("resubscribe replaced the channel containing queued events")
	}

	var forwarded []Event

	for range 2 {
		event := <-liveEvents

		if !writeLiveEvent(filter, event, func(event Event) bool {
			forwarded = append(forwarded, event)

			return true
		}) {
			t.Fatal("writing a live event failed")
		}
	}

	if len(forwarded) != 1 || forwarded[0].ID != want.ID {
		t.Fatalf("forwarded events = %#v, want only event %q", forwarded, want.ID)
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
