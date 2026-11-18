package events

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
)

func TestStorageMonitorThresholdTransitions(t *testing.T) {
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

	available := StorageLowThreshold - 1
	normalizer := NewNormalizer(func() time.Time { return time.UnixMilli(1) }, func(time.Time) string { return "01J5KZ00000000000000000000" })
	monitor := NewStorageMonitor("/opt", func(string) (uint64, error) { return available, nil }, NewInternalPublisher(bus, normalizer), eventsTestLogger())

	monitor.Check()
	monitor.Check()

	if event := receiveStorageEvent(t, subscription.Events()); event.Topic != contractEvents.TopicStorageLow {
		t.Fatalf("topic = %q", event.Topic)
	}

	select {
	case event := <-subscription.Events():
		t.Fatalf("duplicate low event = %#v", event)
	default:
	}

	available = StorageLowThreshold

	monitor.Check()

	available = StorageLowThreshold - 1

	monitor.Check()

	select {
	case event := <-subscription.Events():
		t.Fatalf("equality rearmed storage monitor = %#v", event)
	default:
	}

	available = StorageLowThreshold + 1

	monitor.Check()

	available = StorageLowThreshold - 1

	monitor.Check()

	if receiveStorageEvent(t, subscription.Events()).Topic != contractEvents.TopicStorageLow {
		t.Fatal("strictly-above value did not rearm monitor")
	}
}

func TestStorageMonitorIgnoresFailedChecks(t *testing.T) {
	bus := NewBus()
	filter, _ := ParseTopicFilter([]string{"*"})
	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	monitor := NewStorageMonitor("/opt", func(string) (uint64, error) { return 0, errors.New("stat failed") }, nil, eventsTestLogger())

	monitor.Check()

	select {
	case event := <-subscription.Events():
		t.Fatalf("failed check published event = %#v", event)
	default:
	}
}

func receiveStorageEvent(t *testing.T, channel <-chan Event) Event {
	t.Helper()

	select {
	case event := <-channel:
		var payload map[string]any

		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}

		if payload["path"] != "/opt" {
			t.Fatalf("payload = %#v", payload)
		}

		return event
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for storage event")

		return Event{}
	}
}
