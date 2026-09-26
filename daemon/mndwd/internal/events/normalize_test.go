package events

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
)

func fixedNormalizer() *Normalizer {
	return NewNormalizer(
		func() time.Time { return time.UnixMilli(1725552000123) },
		func(time.Time) string { return "01J5KZ00000000000000000000" },
	)
}

func TestNormalizerMapsWanStartAndStop(t *testing.T) {
	normalizer := fixedNormalizer()

	connected, err := normalizer.NormalizeHook(HookRequest{
		Hook:   "wan.d",
		Action: "start",
		Payload: map[string]any{
			"interface": "ppp0",
			"address":   "192.0.2.1",
			"mask":      "255.255.255.0",
			"gateway":   "192.0.2.254",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if connected.Topic != contractEvents.TopicWanConnected || connected.Source != contractEvents.SourceHook {
		t.Fatalf("connected event = %#v", connected)
	}

	disconnected, err := normalizer.NormalizeHook(HookRequest{
		Hook:   "wan.d",
		Action: "stop",
		Payload: map[string]any{
			"interface": "ppp0",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if disconnected.Topic != contractEvents.TopicWanDisconnected {
		t.Fatalf("disconnected event = %#v", disconnected)
	}
}

func TestNormalizerMapsActionlessHooksAndRenamesFields(t *testing.T) {
	normalizer := fixedNormalizer()

	event, err := normalizer.NormalizeHook(HookRequest{
		Hook: "button.d",
		Payload: map[string]any{
			"button": "reset",
			"action": "long",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if event.Topic != contractEvents.TopicButtonPressed || string(event.Payload) != `{"button":"reset","gesture":"long"}` {
		t.Fatalf("button event = %#v", event)
	}

	event, err = normalizer.NormalizeHook(HookRequest{
		Hook:   "fs.d",
		Action: "start",
		Payload: map[string]any{
			"type":      "ext4",
			"label":     "DATA",
			"directory": "/opt",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if event.Topic != contractEvents.TopicFsMounted || !strings.Contains(string(event.Payload), `"fs_type":"ext4"`) {
		t.Fatalf("filesystem event = %#v", event)
	}
}

func TestNormalizerRejectsUnsupportedHookAndOversizedPayload(t *testing.T) {
	normalizer := fixedNormalizer()

	if _, err := normalizer.NormalizeHook(HookRequest{Hook: "wan.d", Action: "unknown"}); !errors.Is(err, ErrUnsupportedHook) {
		t.Fatalf("unsupported hook error = %v", err)
	}

	if _, err := normalizer.NormalizeHook(HookRequest{
		Hook:    "button.d",
		Payload: map[string]any{"button": "reset", "action": strings.Repeat("x", MaxEventPayloadBytes)},
	}); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("large payload error = %v", err)
	}
}

func TestNormalizerHookPayloadsMatchContractFixtures(t *testing.T) {
	tests := []struct {
		fixture string
		request HookRequest
	}{
		{fixture: "wan-connected.json", request: HookRequest{Hook: "wan.d", Action: "start", Payload: map[string]any{
			"interface": "ppp0", "address": "192.0.2.1", "mask": "255.255.255.0", "gateway": "192.0.2.254",
		}}},
		{fixture: "wan-disconnected.json", request: HookRequest{Hook: "wan.d", Action: "stop", Payload: map[string]any{"interface": "ppp0"}}},
		{fixture: "net-ip-changed.json", request: HookRequest{Hook: "ifipchanged.d", Payload: map[string]any{
			"address": "192.0.2.1", "mask": "255.255.255.0", "link": "wan", "connected": true,
		}}},
		{fixture: "firewall-rebuilt.json", request: HookRequest{Hook: "netfilter.d", Payload: map[string]any{"type": "filter", "table": "inet"}}},
		{fixture: "usb-attached.json", request: HookRequest{Hook: "usb.d", Action: "start", Payload: map[string]any{
			"device": "/dev/sda1", "model": "Disk", "vendor": "ACME", "port": "usb1",
		}}},
		{fixture: "usb-detached.json", request: HookRequest{Hook: "usb.d", Action: "stop", Payload: map[string]any{"device": "/dev/sda1", "port": "usb1"}}},
		{fixture: "fs-mounted.json", request: HookRequest{Hook: "fs.d", Action: "start", Payload: map[string]any{
			"type": "ext4", "label": "DATA", "directory": "/opt",
		}}},
		{fixture: "fs-unmounted.json", request: HookRequest{Hook: "fs.d", Action: "stop", Payload: map[string]any{"label": "DATA", "directory": "/opt"}}},
		{fixture: "clock-synced.json", request: HookRequest{Hook: "time.d", Payload: map[string]any{}}},
		{fixture: "schedule-fired.json", request: HookRequest{Hook: "schedule.d", Action: "start", Payload: map[string]any{"schedule": "nightly", "elapsed": float64(0)}}},
		{fixture: "button-pressed.json", request: HookRequest{Hook: "button.d", Payload: map[string]any{"button": "reset", "action": "short"}}},
	}

	for _, test := range tests {
		t.Run(test.fixture, func(t *testing.T) {
			fixtureBytes, err := os.ReadFile(filepath.Join("fixtures/valid", test.fixture))
			if err != nil {
				t.Fatal(err)
			}

			var fixture Event

			if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
				t.Fatal(err)
			}

			event, err := fixedNormalizer().NormalizeHook(test.request)
			if err != nil {
				t.Fatal(err)
			}

			if event.Topic != fixture.Topic || event.Source != fixture.Source || string(event.Payload) != string(fixture.Payload) {
				t.Fatalf("event topic/source/payload = %s/%s/%s, fixture = %s/%s/%s", event.Topic, event.Source, event.Payload, fixture.Topic, fixture.Source, fixture.Payload)
			}
		})
	}
}

func TestNormalizerRejectsMalformedTypedHookAndLogPayloads(t *testing.T) {
	normalizer := fixedNormalizer()

	for _, request := range []HookRequest{
		{Hook: "wan.d", Action: "start", Payload: map[string]any{"interface": "ppp0"}},
		{Hook: "time.d", Payload: map[string]any{"offset_ms": "now"}},
		{Hook: "ifipchanged.d", Payload: map[string]any{"address": "192.0.2.1", "mask": "255.255.255.0", "link": "wan", "connected": "yes"}},
	} {
		if _, err := normalizer.NormalizeHook(request); err == nil {
			t.Errorf("malformed hook accepted: %#v", request)
		}
	}

	if _, err := normalizer.NormalizeLog(contractEvents.TopicAuthLogin, map[string]any{"user": "admin"}, testParsedTime); err == nil {
		t.Fatal("map payload accepted for typed log topic")
	}
}

func TestNormalizerLogPayloadMatchesContractFixtureAndSizeBound(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("fixtures/valid", "auth-login.json"))
	if err != nil {
		t.Fatal(err)
	}

	var fixture Event

	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}

	extracted := extractAuthLogin(testParsed("ndm", `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.0.2.2:Home/ agent Chrome`))

	if extracted == nil {
		t.Fatal("auth fixture log did not extract")
	}

	event, err := fixedNormalizer().NormalizeLog(extracted.Topic, extracted.Payload, testParsedTime)
	if err != nil {
		t.Fatal(err)
	}

	if event.Topic != fixture.Topic || event.Source != contractEvents.SourceLog || string(event.Payload) != string(fixture.Payload) {
		t.Fatalf("event topic/source/payload = %s/%s/%s, fixture = %s/%s/%s", event.Topic, event.Source, event.Payload, fixture.Topic, fixture.Source, fixture.Payload)
	}

	large := contractEvents.AuthLoginPayload{User: strings.Repeat("x", MaxEventPayloadBytes)}

	if _, err := fixedNormalizer().NormalizeLog(contractEvents.TopicAuthLogin, large, testParsedTime); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("oversized log error = %v, want %v", err, ErrPayloadTooLarge)
	}
}

func TestDeduplicatorPrefersRecentHookEvent(t *testing.T) {
	now := time.UnixMilli(1725552000123)
	deduplicator := NewDeduplicator(func() time.Time { return now })
	normalizer := fixedNormalizer()
	hook, err := normalizer.NormalizeHook(HookRequest{
		Hook:    "wan.d",
		Action:  "stop",
		Payload: map[string]any{"interface": "ppp0"},
	})
	if err != nil {
		t.Fatal(err)
	}

	logEvent, err := normalizer.NormalizeLog(contractEvents.TopicWanDisconnected, contractEvents.WanDisconnectedPayload{Interface: "ppp0"}, now)
	if err != nil {
		t.Fatal(err)
	}

	if !deduplicator.Accept(hook) || deduplicator.Accept(logEvent) {
		t.Fatal("recent hook was not preferred")
	}

	now = now.Add(6 * time.Second)

	if !deduplicator.Accept(logEvent) {
		t.Fatal("expired hook suppressed log event")
	}
}
