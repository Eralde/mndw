package events

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	contractEvents "mndw.local/contracts/events"
)

const MaxEventPayloadBytes = 4 * 1024

var (
	ErrUnsupportedHook = errors.New("unsupported event hook or action")
	ErrPayloadTooLarge = errors.New("event payload is too large")
)

type HookRequest struct {
	Hook    string         `json:"hook"`
	Action  string         `json:"action"`
	Payload map[string]any `json:"payload"`
}

type Normalizer struct {
	now func() time.Time
	id  func(time.Time) string
}

func NewNormalizer(now func() time.Time, id func(time.Time) string) *Normalizer {
	if now == nil {
		now = time.Now
	}

	if id == nil {
		id = newULID
	}

	return &Normalizer{now: now, id: id}
}

func (n *Normalizer) NormalizeHook(request HookRequest) (Event, error) {
	payload, topic, err := normalizeHookPayload(request)
	if err != nil {
		return Event{}, err
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return Event{}, fmt.Errorf("encode hook payload: %w", err)
	}

	if len(encoded) > MaxEventPayloadBytes {
		return Event{}, ErrPayloadTooLarge
	}

	now := n.now()

	return Event{
		ID:      n.id(now),
		Ts:      now.UnixMilli(),
		Topic:   topic,
		Source:  contractEvents.SourceHook,
		Payload: encoded,
	}, nil
}

func (n *Normalizer) NormalizeLog(topic contractEvents.Topic, payload map[string]any, timestamp time.Time) (Event, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Event{}, fmt.Errorf("encode log payload: %w", err)
	}

	if len(encoded) > MaxEventPayloadBytes {
		return Event{}, ErrPayloadTooLarge
	}

	return Event{
		ID:      n.id(timestamp),
		Ts:      timestamp.UnixMilli(),
		Topic:   topic,
		Source:  contractEvents.SourceLog,
		Payload: encoded,
	}, nil
}

func (n *Normalizer) NormalizeInternal(topic contractEvents.Topic, payload map[string]any) (Event, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Event{}, fmt.Errorf("encode internal payload: %w", err)
	}

	if len(encoded) > MaxEventPayloadBytes {
		return Event{}, ErrPayloadTooLarge
	}

	now := n.now()

	return Event{ID: n.id(now), Ts: now.UnixMilli(), Topic: topic, Source: contractEvents.SourceInternal, Payload: encoded}, nil
}

func normalizeHookPayload(request HookRequest) (map[string]any, contractEvents.Topic, error) {
	if !strings.HasSuffix(request.Hook, ".d") {
		request.Hook += ".d"
	}

	get := func(key string) (string, error) {
		value, ok := request.Payload[key]

		if !ok {
			return "", fmt.Errorf("hook %s payload missing %s", request.Hook, key)
		}

		text, ok := value.(string)

		if !ok || text == "" {
			return "", fmt.Errorf("hook %s payload %s must be a non-empty string", request.Hook, key)
		}

		return text, nil
	}
	getAnyString := func(keys ...string) (string, error) {
		for _, key := range keys {
			if value, ok := request.Payload[key]; ok {
				text, ok := value.(string)

				if ok && text != "" {
					return text, nil
				}
			}
		}

		return "", fmt.Errorf("hook %s payload missing %s", request.Hook, strings.Join(keys, " or "))
	}

	switch request.Hook {
	case "wan.d":
		if request.Action != "start" && request.Action != "stop" {
			return nil, "", ErrUnsupportedHook
		}

		interfaceName, err := get("interface")
		if err != nil {
			return nil, "", err
		}

		if request.Action == "stop" {
			return map[string]any{"interface": interfaceName}, contractEvents.TopicWanDisconnected, nil
		}

		address, err := get("address")
		if err != nil {
			return nil, "", err
		}

		mask, err := get("mask")
		if err != nil {
			return nil, "", err
		}

		gateway, err := get("gateway")
		if err != nil {
			return nil, "", err
		}

		return map[string]any{"interface": interfaceName, "address": address, "mask": mask, "gateway": gateway}, contractEvents.TopicWanConnected, nil
	case "fs.d":
		if request.Action != "start" && request.Action != "stop" {
			return nil, "", ErrUnsupportedHook
		}

		label, err := get("label")
		if err != nil {
			return nil, "", err
		}

		directory, err := get("directory")
		if err != nil {
			return nil, "", err
		}

		if request.Action == "stop" {
			return map[string]any{"label": label, "directory": directory}, contractEvents.TopicFsUnmounted, nil
		}

		fsType, err := getAnyString("type", "fs_type")
		if err != nil {
			return nil, "", err
		}

		return map[string]any{"fs_type": fsType, "label": label, "directory": directory}, contractEvents.TopicFsMounted, nil
	case "usb.d":
		if request.Action != "start" && request.Action != "stop" {
			return nil, "", ErrUnsupportedHook
		}

		device, err := getAnyString("usb_device", "device")
		if err != nil {
			return nil, "", err
		}

		port, err := get("port")
		if err != nil {
			return nil, "", err
		}

		if request.Action == "stop" {
			return map[string]any{"device": device, "port": port}, contractEvents.TopicUSBDetached, nil
		}

		model, err := get("model")
		if err != nil {
			return nil, "", err
		}

		vendor, err := get("vendor")
		if err != nil {
			return nil, "", err
		}

		return map[string]any{"device": device, "model": model, "vendor": vendor, "port": port}, contractEvents.TopicUSBAttached, nil
	case "netfilter.d":
		if request.Action != "" {
			return nil, "", ErrUnsupportedHook
		}

		tableType, err := getAnyString("type", "table_type")
		if err != nil {
			return nil, "", err
		}

		table, err := get("table")
		if err != nil {
			return nil, "", err
		}

		return map[string]any{"table_type": tableType, "table": table}, contractEvents.TopicFirewallRebuilt, nil
	case "time.d":
		if request.Action != "" {
			return nil, "", ErrUnsupportedHook
		}

		payload := make(map[string]any)

		if offset, ok := request.Payload["offset_ms"]; ok {
			switch value := offset.(type) {
			case int:
				payload["offset_ms"] = value
			case int64:
				payload["offset_ms"] = value
			case float64:
				if value != float64(int64(value)) {
					return nil, "", fmt.Errorf("time offset must be an integer")
				}

				payload["offset_ms"] = int64(value)
			default:
				return nil, "", fmt.Errorf("time offset must be numeric")
			}
		}

		return payload, contractEvents.TopicClockSynced, nil
	case "schedule.d":
		if request.Action != "start" && request.Action != "stop" {
			return nil, "", ErrUnsupportedHook
		}

		name, err := getAnyString("schedule", "name")
		if err != nil {
			return nil, "", err
		}

		elapsed := int64(0)

		if value, ok := request.Payload["elapsed"]; ok {
			if number, ok := value.(float64); ok && number >= 0 && number == float64(int64(number)) {
				elapsed = int64(number)
			}
		}

		return map[string]any{"name": name, "action": request.Action, "elapsed": elapsed}, contractEvents.TopicScheduleFired, nil
	case "button.d":
		if request.Action != "" {
			return nil, "", ErrUnsupportedHook
		}

		button, err := get("button")
		if err != nil {
			return nil, "", err
		}

		gesture, err := getAnyString("action", "gesture")
		if err != nil {
			return nil, "", err
		}

		return map[string]any{"button": button, "gesture": gesture}, contractEvents.TopicButtonPressed, nil
	case "ifipchanged.d":
		if request.Action != "" {
			return nil, "", ErrUnsupportedHook
		}

		address, err := get("address")
		if err != nil {
			return nil, "", err
		}

		mask, err := get("mask")
		if err != nil {
			return nil, "", err
		}

		link, err := get("link")
		if err != nil {
			return nil, "", err
		}

		connected, ok := request.Payload["connected"].(bool)

		if !ok {
			return nil, "", fmt.Errorf("hook %s payload connected must be boolean", request.Hook)
		}

		return map[string]any{"address": address, "mask": mask, "link": link, "connected": connected}, contractEvents.TopicNetIPChanged, nil
	default:
		return nil, "", ErrUnsupportedHook
	}
}

const ulidEncoding = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newULID(now time.Time) string {
	var randomPart [10]byte

	if _, err := rand.Read(randomPart[:]); err != nil {
		binary.BigEndian.PutUint64(randomPart[:8], uint64(now.UnixNano()))
		binary.BigEndian.PutUint16(randomPart[8:], uint16(now.UnixNano()))
	}

	timestamp := uint64(now.UnixMilli())
	var result [26]byte

	for index := 9; index >= 0; index-- {
		result[index] = ulidEncoding[timestamp&31]
		timestamp >>= 5
	}

	for index := 0; index < 16; index++ {
		if index < 8 {
			result[10+index] = ulidEncoding[(uint64(randomPart[index])>>3)&31]
		} else {
			result[10+index] = ulidEncoding[uint64(randomPart[index-8])&31]
		}
	}

	return string(result[:])
}
