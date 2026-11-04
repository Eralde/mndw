package events

import (
	"errors"
	"sync"
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

func TestSubscriptionSetFilterKeepsBufferedEvents(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}

	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	event := testEvent("01J5KZ00000000000000000011", "wan.connected")

	bus.Publish(event)

	wanFilter, err := ParseTopicFilter([]string{"wan"})
	if err != nil {
		t.Fatal(err)
	}

	subscription.SetFilter(wanFilter)

	got := <-subscription.Events()

	if got.ID != event.ID {
		t.Fatalf("event ID = %q, want %q", got.ID, event.ID)
	}
}

func TestSubscriptionSetFilterAppliesToLaterPublishes(t *testing.T) {
	bus := NewBus()
	wanFilter, err := ParseTopicFilter([]string{"wan"})
	if err != nil {
		t.Fatal(err)
	}

	subscription, err := bus.SubscribeHandle(wanFilter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	systemFilter, err := ParseTopicFilter([]string{"system"})
	if err != nil {
		t.Fatal(err)
	}

	subscription.SetFilter(systemFilter)
	bus.Publish(testEvent("01J5KZ00000000000000000012", "wan.connected"))

	want := testEvent("01J5KZ00000000000000000013", "system.x")

	bus.Publish(want)

	got := <-subscription.Events()

	if got.ID != want.ID {
		t.Fatalf("event ID = %q, want %q", got.ID, want.ID)
	}

	select {
	case got := <-subscription.Events():
		t.Fatalf("unexpected extra event: %#v", got)
	default:
	}
}

func TestSubscriptionSetFilterDoesNotAddSubscriber(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"wan"})
	if err != nil {
		t.Fatal(err)
	}

	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	before := len(bus.subscribers)
	filter, err = ParseTopicFilter([]string{"system"})
	if err != nil {
		t.Fatal(err)
	}

	subscription.SetFilter(filter)

	if got := len(bus.subscribers); got != before {
		t.Fatalf("subscriber count = %d, want unchanged at %d", got, before)
	}
}

func TestSubscriptionSetFilterAfterCancelIsNoop(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"wan"})
	if err != nil {
		t.Fatal(err)
	}

	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	subscription.Cancel()

	filter, err = ParseTopicFilter([]string{"system"})
	if err != nil {
		t.Fatal(err)
	}

	subscription.SetFilter(filter)

	if _, ok := <-subscription.Events(); ok {
		t.Fatal("subscription channel remained open after cancel")
	}
}

func TestSubscriptionSetFilterRacesWithPublish(t *testing.T) {
	bus := NewBus()
	allFilter, err := ParseTopicFilter([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}

	subscription, err := bus.SubscribeHandle(allFilter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	filters := []TopicFilter{}

	for _, topics := range [][]string{{"wan"}, {"system"}} {
		filter, parseErr := ParseTopicFilter(topics)

		if parseErr != nil {
			t.Fatal(parseErr)
		}

		filters = append(filters, filter)
	}

	var wait sync.WaitGroup

	wait.Add(2)

	go func() {
		defer wait.Done()

		for index := 0; index < 1000; index++ {
			subscription.SetFilter(filters[index%len(filters)])
		}
	}()

	go func() {
		defer wait.Done()

		for index := 0; index < 1000; index++ {
			topic := "wan.connected"

			if index%2 == 0 {
				topic = "system.x"
			}

			bus.Publish(testEvent("01J5KZ00000000000000000014", topic))
		}
	}()

	wait.Wait()
}
