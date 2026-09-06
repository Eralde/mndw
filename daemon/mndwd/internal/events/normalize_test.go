package events

import (
	"errors"
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

	logEvent, err := normalizer.NormalizeLog(contractEvents.TopicWanDisconnected, map[string]any{"interface": "ppp0"}, now)
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
