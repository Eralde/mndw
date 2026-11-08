package events

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
)

func TestInternalPublisherEmitsTypedPayloads(t *testing.T) {
	tests := []struct {
		name    string
		topic   contractEvents.Topic
		payload string
		publish func(*InternalPublisher) error
	}{
		{
			name: "plugin installed", topic: contractEvents.TopicPluginInstalled, payload: `{"name":"demo","version":"1.2.3"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishPluginInstalled(contractEvents.PluginInstalledPayload{Name: "demo", Version: "1.2.3"})
			},
		},
		{
			name: "plugin approved", topic: contractEvents.TopicPluginApproved, payload: `{"name":"demo","version":"1.2.3"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishPluginApproved(contractEvents.PluginApprovedPayload{Name: "demo", Version: "1.2.3"})
			},
		},
		{
			name: "plugin removed", topic: contractEvents.TopicPluginRemoved, payload: `{"name":"demo"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishPluginRemoved(contractEvents.PluginRemovedPayload{Name: "demo"})
			},
		},
		{
			name: "plugin started", topic: contractEvents.TopicPluginStarted, payload: `{"name":"demo"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishPluginStarted(contractEvents.PluginStartedPayload{Name: "demo"})
			},
		},
		{
			name: "plugin stopped", topic: contractEvents.TopicPluginStopped, payload: `{"name":"demo","reason":"shutdown"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishPluginStopped(contractEvents.PluginStoppedPayload{Name: "demo", Reason: "shutdown"})
			},
		},
		{
			name: "daemon started", topic: contractEvents.TopicDaemonStarted, payload: `{"version":"2.0.0","uptime_ms":12}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishDaemonStarted(contractEvents.DaemonStartedPayload{Version: "2.0.0", UptimeMs: 12})
			},
		},
		{
			name: "daemon stopping", topic: contractEvents.TopicDaemonStopping, payload: `{"reason":"shutdown"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishDaemonStopping(contractEvents.DaemonStoppingPayload{Reason: "shutdown"})
			},
		},
		{
			name: "daemon updated", topic: contractEvents.TopicDaemonUpdated, payload: `{"version":"2.0.0"}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishDaemonUpdated(contractEvents.DaemonUpdatedPayload{Version: "2.0.0"})
			},
		},
		{
			name: "storage low", topic: contractEvents.TopicStorageLow, payload: `{"path":"/opt","available_bytes":5,"threshold_bytes":10}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishStorageLow(contractEvents.StorageLowPayload{Path: "/opt", AvailableBytes: 5, ThresholdBytes: 10})
			},
		},
		{
			name: "telemetry gathering changed", topic: contractEvents.TopicTelemetryGatheringChanged, payload: `{"enabled":false}`,
			publish: func(p *InternalPublisher) error {
				return p.PublishTelemetryGatheringChanged(contractEvents.TelemetryGatheringChangedPayload{Enabled: false})
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bus := NewBus()
			filter, err := ParseTopicFilter([]string{"*"})
			if err != nil {
				t.Fatal(err)
			}

			events, cancel, err := bus.Subscribe(filter)
			if err != nil {
				t.Fatal(err)
			}

			defer cancel()

			publisher := NewInternalPublisher(bus, fixedNormalizer())

			if err := test.publish(publisher); err != nil {
				t.Fatal(err)
			}

			got := <-events

			if got.Topic != test.topic || got.Source != contractEvents.SourceInternal || string(got.Payload) != test.payload {
				t.Fatalf("event = %#v, payload = %s; want topic %q source %q payload %s", got, got.Payload, test.topic, contractEvents.SourceInternal, test.payload)
			}
		})
	}
}

func TestInternalPublisherRejectsOversizedPayloadsByFamily(t *testing.T) {
	large := strings.Repeat("x", MaxEventPayloadBytes)
	tests := []struct {
		name    string
		publish func(*InternalPublisher) error
	}{
		{name: "plugin", publish: func(p *InternalPublisher) error {
			return p.PublishPluginInstalled(contractEvents.PluginInstalledPayload{Name: large})
		}},
		{name: "daemon", publish: func(p *InternalPublisher) error {
			return p.PublishDaemonStopping(contractEvents.DaemonStoppingPayload{Reason: large})
		}},
		{name: "storage", publish: func(p *InternalPublisher) error {
			return p.PublishStorageLow(contractEvents.StorageLowPayload{Path: large})
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			publisher := NewInternalPublisher(NewBus(), fixedNormalizer())

			if err := test.publish(publisher); !errors.Is(err, ErrPayloadTooLarge) {
				t.Fatalf("publish error = %v, want %v", err, ErrPayloadTooLarge)
			}
		})
	}
}

func TestEncodePayloadRejectsPointerForKnownTopic(t *testing.T) {
	_, err := encodePayload(contractEvents.TopicPluginInstalled, &contractEvents.PluginInstalledPayload{Name: "demo"})
	if err == nil {
		t.Fatal("pointer payload accepted for plugin.installed")
	}
}

func TestInternalPublisherUsesFixedClock(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"daemon.started"})
	if err != nil {
		t.Fatal(err)
	}

	events, cancel, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancel()

	if err := NewInternalPublisher(bus, fixedNormalizer()).PublishDaemonStarted(contractEvents.DaemonStartedPayload{Version: "2"}); err != nil {
		t.Fatal(err)
	}

	if got := (<-events).Ts; got != time.UnixMilli(1725552000123).UnixMilli() {
		t.Fatalf("timestamp = %d", got)
	}
}

func TestEncodePayloadMatchesEveryContractFixture(t *testing.T) {
	payloadTypes := map[contractEvents.Topic]reflect.Type{
		contractEvents.TopicWanConnected:              reflect.TypeOf(contractEvents.WanConnectedPayload{}),
		contractEvents.TopicWanDisconnected:           reflect.TypeOf(contractEvents.WanDisconnectedPayload{}),
		contractEvents.TopicNetIPChanged:              reflect.TypeOf(contractEvents.NetIPChangedPayload{}),
		contractEvents.TopicNetDhcpLease:              reflect.TypeOf(contractEvents.NetDhcpLeasePayload{}),
		contractEvents.TopicNetDnsChanged:             reflect.TypeOf(contractEvents.NetDnsChangedPayload{}),
		contractEvents.TopicWifiClientJoin:            reflect.TypeOf(contractEvents.WifiClientJoinPayload{}),
		contractEvents.TopicWifiClientLeave:           reflect.TypeOf(contractEvents.WifiClientLeavePayload{}),
		contractEvents.TopicFirewallRebuilt:           reflect.TypeOf(contractEvents.FirewallRebuiltPayload{}),
		contractEvents.TopicUSBAttached:               reflect.TypeOf(contractEvents.USBAttachedPayload{}),
		contractEvents.TopicUSBDetached:               reflect.TypeOf(contractEvents.USBDetachedPayload{}),
		contractEvents.TopicFsMounted:                 reflect.TypeOf(contractEvents.FsMountedPayload{}),
		contractEvents.TopicFsUnmounted:               reflect.TypeOf(contractEvents.FsUnmountedPayload{}),
		contractEvents.TopicClockSynced:               reflect.TypeOf(contractEvents.ClockSyncedPayload{}),
		contractEvents.TopicScheduleFired:             reflect.TypeOf(contractEvents.ScheduleFiredPayload{}),
		contractEvents.TopicButtonPressed:             reflect.TypeOf(contractEvents.ButtonPressedPayload{}),
		contractEvents.TopicAuthLogin:                 reflect.TypeOf(contractEvents.AuthLoginPayload{}),
		contractEvents.TopicFirmwareAvailable:         reflect.TypeOf(contractEvents.FirmwareAvailablePayload{}),
		contractEvents.TopicPluginInstalled:           reflect.TypeOf(contractEvents.PluginInstalledPayload{}),
		contractEvents.TopicPluginRemoved:             reflect.TypeOf(contractEvents.PluginRemovedPayload{}),
		contractEvents.TopicPluginApproved:            reflect.TypeOf(contractEvents.PluginApprovedPayload{}),
		contractEvents.TopicPluginStarted:             reflect.TypeOf(contractEvents.PluginStartedPayload{}),
		contractEvents.TopicPluginStopped:             reflect.TypeOf(contractEvents.PluginStoppedPayload{}),
		contractEvents.TopicDaemonStarted:             reflect.TypeOf(contractEvents.DaemonStartedPayload{}),
		contractEvents.TopicDaemonStopping:            reflect.TypeOf(contractEvents.DaemonStoppingPayload{}),
		contractEvents.TopicDaemonUpdated:             reflect.TypeOf(contractEvents.DaemonUpdatedPayload{}),
		contractEvents.TopicStorageLow:                reflect.TypeOf(contractEvents.StorageLowPayload{}),
		contractEvents.TopicTelemetryGatheringChanged: reflect.TypeOf(contractEvents.TelemetryGatheringChangedPayload{}),
	}

	entries, err := os.ReadDir("fixtures/valid")
	if err != nil {
		t.Fatal(err)
	}

	if len(entries) != len(payloadTypes) {
		t.Fatalf("valid event fixture count = %d, want %d", len(entries), len(payloadTypes))
	}

	seen := make(map[contractEvents.Topic]bool, len(payloadTypes))

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		raw, err := os.ReadFile(filepath.Join("fixtures/valid", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}

		var fixture Event

		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("decode %s: %v", entry.Name(), err)
		}

		payloadType, ok := payloadTypes[fixture.Topic]

		if !ok {
			t.Fatalf("fixture %s has unregistered topic %q", entry.Name(), fixture.Topic)
		}

		seen[fixture.Topic] = true
		value := reflect.New(payloadType)

		if err := json.Unmarshal(fixture.Payload, value.Interface()); err != nil {
			t.Fatalf("decode %s payload: %v", entry.Name(), err)
		}

		payload := value.Elem().Interface()
		encoded, err := encodePayload(fixture.Topic, payload)
		if err != nil {
			t.Fatalf("encode %s: %v", entry.Name(), err)
		}

		if string(encoded) != string(fixture.Payload) {
			t.Fatalf("encoded %s payload = %s, fixture = %s", entry.Name(), encoded, fixture.Payload)
		}

		wrongTopic := contractEvents.TopicWanDisconnected

		if fixture.Topic == wrongTopic {
			wrongTopic = contractEvents.TopicWanConnected
		}

		wrongPayload := reflect.New(payloadTypes[wrongTopic]).Elem().Interface()

		if _, err := encodePayload(fixture.Topic, wrongPayload); err == nil {
			t.Errorf("fixture %s accepted payload type %T", entry.Name(), wrongPayload)
		}

		if _, err := encodePayload(fixture.Topic, value.Interface()); err == nil {
			t.Errorf("fixture %s accepted pointer payload type %T", entry.Name(), value.Interface())
		}
	}

	if len(seen) != len(payloadTypes) {
		t.Fatalf("encoded topics = %d, want %d", len(seen), len(payloadTypes))
	}

	if _, err := encodePayload(contractEvents.Topic("unknown.topic"), contractEvents.WanConnectedPayload{}); err == nil {
		t.Fatal("unknown topic accepted")
	}
}
