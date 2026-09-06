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

	channel, cancel, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancel()

	available := StorageLowThreshold - 1
	normalizer := NewNormalizer(func() time.Time { return time.UnixMilli(1) }, func(time.Time) string { return "01J5KZ00000000000000000000" })
	monitor := NewStorageMonitor("/opt", func(string) (uint64, error) { return available, nil }, NewInternalPublisher(bus, normalizer), nil)

	monitor.Check()
	monitor.Check()

	if event := receiveStorageEvent(t, channel); event.Topic != contractEvents.TopicStorageLow {
		t.Fatalf("topic = %q", event.Topic)
	}

	select {
	case event := <-channel:
		t.Fatalf("duplicate low event = %#v", event)
	default:
	}

	available = StorageLowThreshold

	monitor.Check()

	available = StorageLowThreshold - 1

	monitor.Check()

	select {
	case event := <-channel:
		t.Fatalf("equality rearmed storage monitor = %#v", event)
	default:
	}

	available = StorageLowThreshold + 1

	monitor.Check()

	available = StorageLowThreshold - 1

	monitor.Check()

	if receiveStorageEvent(t, channel).Topic != contractEvents.TopicStorageLow {
		t.Fatal("strictly-above value did not rearm monitor")
	}
}

func TestStorageMonitorIgnoresFailedChecks(t *testing.T) {
	bus := NewBus()
	filter, _ := ParseTopicFilter([]string{"*"})
	channel, cancel, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancel()

	monitor := NewStorageMonitor("/opt", func(string) (uint64, error) { return 0, errors.New("stat failed") }, nil, nil)

	monitor.Check()

	select {
	case event := <-channel:
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
