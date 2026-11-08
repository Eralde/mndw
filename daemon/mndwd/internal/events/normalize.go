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

	encoded, err := encodePayload(topic, payload)
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

func (n *Normalizer) NormalizeLog(topic contractEvents.Topic, payload any, timestamp time.Time) (Event, error) {
	encoded, err := encodePayload(topic, payload)
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

func (n *Normalizer) NormalizeInternal(topic contractEvents.Topic, payload any) (Event, error) {
	encoded, err := encodePayload(topic, payload)
	if err != nil {
		return Event{}, fmt.Errorf("encode internal payload: %w", err)
	}

	if len(encoded) > MaxEventPayloadBytes {
		return Event{}, ErrPayloadTooLarge
	}

	now := n.now()

	return Event{ID: n.id(now), Ts: now.UnixMilli(), Topic: topic, Source: contractEvents.SourceInternal, Payload: encoded}, nil
}

func encodePayload(topic contractEvents.Topic, payload any) ([]byte, error) {
	switch topic {
	case contractEvents.TopicWanConnected:
		return encodeTypedPayload[contractEvents.WanConnectedPayload](topic, payload)
	case contractEvents.TopicWanDisconnected:
		return encodeTypedPayload[contractEvents.WanDisconnectedPayload](topic, payload)
	case contractEvents.TopicNetIPChanged:
		return encodeTypedPayload[contractEvents.NetIPChangedPayload](topic, payload)
	case contractEvents.TopicNetDhcpLease:
		return encodeTypedPayload[contractEvents.NetDhcpLeasePayload](topic, payload)
	case contractEvents.TopicNetDnsChanged:
		return encodeTypedPayload[contractEvents.NetDnsChangedPayload](topic, payload)
	case contractEvents.TopicWifiClientJoin:
		return encodeTypedPayload[contractEvents.WifiClientJoinPayload](topic, payload)
	case contractEvents.TopicWifiClientLeave:
		return encodeTypedPayload[contractEvents.WifiClientLeavePayload](topic, payload)
	case contractEvents.TopicFirewallRebuilt:
		return encodeTypedPayload[contractEvents.FirewallRebuiltPayload](topic, payload)
	case contractEvents.TopicUSBAttached:
		return encodeTypedPayload[contractEvents.USBAttachedPayload](topic, payload)
	case contractEvents.TopicUSBDetached:
		return encodeTypedPayload[contractEvents.USBDetachedPayload](topic, payload)
	case contractEvents.TopicFsMounted:
		return encodeTypedPayload[contractEvents.FsMountedPayload](topic, payload)
	case contractEvents.TopicFsUnmounted:
		return encodeTypedPayload[contractEvents.FsUnmountedPayload](topic, payload)
	case contractEvents.TopicClockSynced:
		return encodeTypedPayload[contractEvents.ClockSyncedPayload](topic, payload)
	case contractEvents.TopicScheduleFired:
		return encodeTypedPayload[contractEvents.ScheduleFiredPayload](topic, payload)
	case contractEvents.TopicButtonPressed:
		return encodeTypedPayload[contractEvents.ButtonPressedPayload](topic, payload)
	case contractEvents.TopicAuthLogin:
		return encodeTypedPayload[contractEvents.AuthLoginPayload](topic, payload)
	case contractEvents.TopicFirmwareAvailable:
		return encodeTypedPayload[contractEvents.FirmwareAvailablePayload](topic, payload)
	case contractEvents.TopicPluginInstalled:
		return encodeTypedPayload[contractEvents.PluginInstalledPayload](topic, payload)
	case contractEvents.TopicPluginApproved:
		return encodeTypedPayload[contractEvents.PluginApprovedPayload](topic, payload)
	case contractEvents.TopicPluginRemoved:
		return encodeTypedPayload[contractEvents.PluginRemovedPayload](topic, payload)
	case contractEvents.TopicPluginStarted:
		return encodeTypedPayload[contractEvents.PluginStartedPayload](topic, payload)
	case contractEvents.TopicPluginStopped:
		return encodeTypedPayload[contractEvents.PluginStoppedPayload](topic, payload)
	case contractEvents.TopicDaemonStarted:
		return encodeTypedPayload[contractEvents.DaemonStartedPayload](topic, payload)
	case contractEvents.TopicDaemonStopping:
		return encodeTypedPayload[contractEvents.DaemonStoppingPayload](topic, payload)
	case contractEvents.TopicDaemonUpdated:
		return encodeTypedPayload[contractEvents.DaemonUpdatedPayload](topic, payload)
	case contractEvents.TopicStorageLow:
		return encodeTypedPayload[contractEvents.StorageLowPayload](topic, payload)
	case contractEvents.TopicTelemetryGatheringChanged:
		return encodeTypedPayload[contractEvents.TelemetryGatheringChangedPayload](topic, payload)
	default:
		return nil, fmt.Errorf("unknown event topic %q", topic)
	}
}

func encodeTypedPayload[T any](topic contractEvents.Topic, payload any) ([]byte, error) {
	value, ok := payload.(T)

	if !ok {
		return nil, payloadTypeError(topic, payload)
	}

	return json.Marshal(value)
}

func payloadTypeError(topic contractEvents.Topic, payload any) error {
	return fmt.Errorf("payload type %T does not match event topic %q", payload, topic)
}

func normalizeHookPayload(request HookRequest) (any, contractEvents.Topic, error) {
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
			return contractEvents.WanDisconnectedPayload{Interface: interfaceName}, contractEvents.TopicWanDisconnected, nil
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

		return contractEvents.WanConnectedPayload{Interface: interfaceName, Address: address, Mask: mask, Gateway: gateway}, contractEvents.TopicWanConnected, nil
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
			return contractEvents.FsUnmountedPayload{Label: label, Directory: directory}, contractEvents.TopicFsUnmounted, nil
		}

		fsType, err := getAnyString("type", "fs_type")
		if err != nil {
			return nil, "", err
		}

		return contractEvents.FsMountedPayload{FsType: fsType, Label: label, Directory: directory}, contractEvents.TopicFsMounted, nil
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
			return contractEvents.USBDetachedPayload{Device: device, Port: port}, contractEvents.TopicUSBDetached, nil
		}

		model, err := get("model")
		if err != nil {
			return nil, "", err
		}

		vendor, err := get("vendor")
		if err != nil {
			return nil, "", err
		}

		return contractEvents.USBAttachedPayload{Device: device, Model: model, Vendor: vendor, Port: port}, contractEvents.TopicUSBAttached, nil
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

		return contractEvents.FirewallRebuiltPayload{TableType: tableType, Table: table}, contractEvents.TopicFirewallRebuilt, nil
	case "time.d":
		if request.Action != "" {
			return nil, "", ErrUnsupportedHook
		}

		var offsetMS *int64

		if offset, ok := request.Payload["offset_ms"]; ok {
			switch value := offset.(type) {
			case int:
				converted := int64(value)
				offsetMS = &converted
			case int64:
				offsetMS = &value
			case float64:
				if value != float64(int64(value)) {
					return nil, "", fmt.Errorf("time offset must be an integer")
				}

				converted := int64(value)
				offsetMS = &converted
			default:
				return nil, "", fmt.Errorf("time offset must be numeric")
			}
		}

		return contractEvents.ClockSyncedPayload{OffsetMs: offsetMS}, contractEvents.TopicClockSynced, nil
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

		return contractEvents.ScheduleFiredPayload{Name: name, Action: request.Action, Elapsed: elapsed}, contractEvents.TopicScheduleFired, nil
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

		return contractEvents.ButtonPressedPayload{Button: button, Gesture: gesture}, contractEvents.TopicButtonPressed, nil
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

		return contractEvents.NetIPChangedPayload{Address: address, Mask: mask, Link: link, Connected: connected}, contractEvents.TopicNetIPChanged, nil
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
