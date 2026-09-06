package events

import (
	"errors"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
)

func testEvent(id, topic string) contractEvents.Event {
	return contractEvents.Event{
		ID:      id,
		Ts:      time.Now().UnixMilli(),
		Topic:   contractEvents.Topic(topic),
		Source:  contractEvents.SourceInternal,
		Payload: []byte(`{}`),
	}
}

func TestTopicFilterUsesDotBoundaries(t *testing.T) {
	filter, err := ParseTopicFilter([]string{"wan", "wifi.client_join"})
	if err != nil {
		t.Fatal(err)
	}

	if !filter.Matches("wan.connected") || !filter.Matches("wifi.client_join") {
		t.Fatal("expected matching topics")
	}

	if filter.Matches("wander.connected") || filter.Matches("wifi.client_leave") {
		t.Fatal("matched topic outside filter")
	}
}

func TestBusReplayUsesPublicationOrderAndExpiresOldCursor(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"net"})
	if err != nil {
		t.Fatal(err)
	}

	for _, event := range []contractEvents.Event{
		testEvent("01J5KZ00000000000000000001", "net.dns_changed"),
		testEvent("01J5KZ00000000000000000000", "net.dhcp_lease"),
		testEvent("01J5KZ00000000000000000002", "wan.connected"),
	} {
		bus.Publish(event)
	}

	result, err := bus.Replay("01J5KZ00000000000000000001", filter, 100)
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Events) != 1 || result.Events[0].ID != "01J5KZ00000000000000000000" {
		t.Fatalf("replay = %#v", result.Events)
	}

	bus.setRingCapacityForTest(1)
	bus.Publish(testEvent("01J5KZ00000000000000000003", "net.dns_changed"))

	if _, err := bus.Replay("01J5KZ00000000000000000001", filter, 100); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("replay error = %v, want cursor expired", err)
	}
}

func TestBusClosesSlowSubscriber(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}

	channel, cancel, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancel()

	for index := 0; index < EventSubscriberCapacity+1; index++ {
		bus.Publish(testEvent("01J5KZ0000000000000000"+string(rune('A'+index)), "net.dns_changed"))
	}

	for range channel {
	}
}

func TestBusLimitsSubscribers(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}

	cancels := make([]CancelFunc, 0, MaxEventSubscribers)

	for index := 0; index < MaxEventSubscribers; index++ {
		_, cancel, subscribeErr := bus.Subscribe(filter)

		if subscribeErr != nil {
			t.Fatal(subscribeErr)
		}

		cancels = append(cancels, cancel)
	}

	defer func() {
		for _, cancel := range cancels {
			cancel()
		}
	}()

	if _, _, err := bus.Subscribe(filter); !errors.Is(err, ErrSubscriberLimit) {
		t.Fatalf("subscribe error = %v, want subscriber limit", err)
	}
}
