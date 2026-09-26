package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
)

func extractedPayload[T any](t *testing.T, event *ExtractedEvent) T {
	t.Helper()

	payload, ok := event.Payload.(T)

	if !ok {
		t.Fatalf("payload type = %T", event.Payload)
	}

	return payload
}

var testParsedTime = time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

func testParsed(ident, message string) ParsedLogRecord {
	return ParsedLogRecord{ID: 1, Timestamp: testParsedTime, Ident: ident, Message: message}
}

func TestExtractDHCPLeaseAdd(t *testing.T) {
	record := testParsed("ndm", `Dhcp::Pool: added host 192.168.1.42 (AA:BB:CC:DD:EE:FF) "iPhone" to pool "Home"`)
	result := extractDHCPLease(record)

	if result == nil {
		t.Fatal("expected match")
	}

	if result.Topic != contractEvents.TopicNetDhcpLease {
		t.Fatalf("topic = %s", result.Topic)
	}

	payload := extractedPayload[contractEvents.NetDhcpLeasePayload](t, result)

	if payload.MAC != "AA:BB:CC:DD:EE:FF" || payload.IP != "192.168.1.42" || payload.Hostname != "iPhone" || payload.Action != "add" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestExtractDHCPLeaseRejectsUnrelated(t *testing.T) {
	record := testParsed("ndm", "Cifs::ServerTsmb: service started.")

	if extractDHCPLease(record) != nil {
		t.Fatal("should not match CIFS message")
	}
}

func TestExtractDHCPLeaseRejectsEmptyHostname(t *testing.T) {
	record := testParsed("ndm", `Dhcp::Pool: added host 192.168.1.42 (AA:BB:CC:DD:EE:FF) "" to pool "Home"`)

	if extractDHCPLease(record) != nil {
		t.Fatal("empty hostname must not produce a contract payload")
	}
}

func TestExtractDNSChanged(t *testing.T) {
	// unverified: regex based on format extrapolation, not a captured sample; replace with capture when available.
	record := testParsed("ndm", "Dns::Manager: static resolver list changed: 8.8.8.8, 1.1.1.1")
	result := extractDNSChanged(record)

	if result == nil {
		t.Fatal("expected match")
	}

	if result.Topic != contractEvents.TopicNetDnsChanged {
		t.Fatalf("topic = %s", result.Topic)
	}

	payload := extractedPayload[contractEvents.NetDnsChangedPayload](t, result)

	if len(payload.Resolvers) != 2 || payload.Resolvers[0] != "8.8.8.8" || payload.Resolvers[1] != "1.1.1.1" {
		t.Fatalf("resolvers = %#v", payload.Resolvers)
	}
}

func TestExtractAuthLoginSuccess(t *testing.T) {
	record := testParsed("ndm", `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.168.1.97:Home/ agent Chrome`)
	result := extractAuthLogin(record)

	if result == nil {
		t.Fatal("expected match")
	}

	if result.Topic != contractEvents.TopicAuthLogin {
		t.Fatalf("topic = %s", result.Topic)
	}

	payload := extractedPayload[contractEvents.AuthLoginPayload](t, result)

	if payload.User != "admin" || payload.Success != true {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestExtractAuthLoginFailure(t *testing.T) {
	record := testParsed("ndm", `Core::Security::Authority: authentication failed for user "admin" from 192.168.1.97`)
	result := extractAuthLogin(record)

	if result == nil {
		t.Fatal("expected match")
	}

	payload := extractedPayload[contractEvents.AuthLoginPayload](t, result)

	if payload.User != "admin" || payload.IP != "192.168.1.97" || payload.Success != false {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestExtractFirmwareAvailable(t *testing.T) {
	// unverified: regex based on format extrapolation, not a captured sample; replace with capture when available.
	record := testParsed("ndm", "Firmware::Manager: new firmware version 4.3.1 is available")
	result := extractFirmwareAvailable(record)

	if result == nil {
		t.Fatal("expected match")
	}

	payload := extractedPayload[contractEvents.FirmwareAvailablePayload](t, result)

	if result.Topic != contractEvents.TopicFirmwareAvailable || payload.Version != "4.3.1" {
		t.Fatalf("result = %#v", result)
	}
}

func TestExtractWiFiClientJoin(t *testing.T) {
	record := testParsed("hostapd", `Associated: AA:BB:CC:DD:EE:FF (2.4GHz, SSID "Home", ra0)`)
	result := extractWiFiClient(record)

	if result == nil {
		t.Fatal("expected match")
	}

	if result.Topic != contractEvents.TopicWifiClientJoin {
		t.Fatalf("topic = %s", result.Topic)
	}

	payload := extractedPayload[contractEvents.WifiClientJoinPayload](t, result)

	if payload.MAC != "AA:BB:CC:DD:EE:FF" || payload.Band != "2.4GHz" || payload.SSID != "Home" || payload.Iface != "ra0" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestExtractWiFiClientLeave(t *testing.T) {
	record := testParsed("kernel", `Disassociated: AA:BB:CC:DD:EE:FF (5GHz, SSID "Home", ra1)`)
	result := extractWiFiClient(record)

	if result == nil {
		t.Fatal("expected match")
	}

	if result.Topic != contractEvents.TopicWifiClientLeave {
		t.Fatalf("topic = %s", result.Topic)
	}

	payload := extractedPayload[contractEvents.WifiClientLeavePayload](t, result)

	if payload.MAC != "AA:BB:CC:DD:EE:FF" || payload.Band != "5GHz" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestExtractWiFiClientMatchesAnyIdent(t *testing.T) {
	for _, ident := range []string{"hostapd", "kernel", "ndm"} {
		record := testParsed(ident, `Associated: AA:BB:CC:DD:EE:FF (5GHz, SSID "Net", wlan0)`)

		if extractWiFiClient(record) == nil {
			t.Fatalf("ident %q should match", ident)
		}
	}
}

func TestDefaultExtractorsOrderFirstMatchWins(t *testing.T) {
	extractors := DefaultExtractors()
	record := testParsed("ndm", `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.168.1.97:Home/ agent Chrome`)

	var matched *ExtractedEvent

	for _, extractor := range extractors {
		if result := extractor(record); result != nil {
			matched = result

			break
		}
	}

	if matched == nil || matched.Topic != contractEvents.TopicAuthLogin {
		t.Fatalf("first-match-wins = %#v", matched)
	}
}

func TestDefaultExtractorsNormalizePayloads(t *testing.T) {
	cases := []struct {
		name     string
		record   ParsedLogRecord
		topic    contractEvents.Topic
		fixture  string
		required []string
	}{
		{
			name:     "auth",
			record:   testParsed("ndm", `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.0.2.2:Home/ agent Chrome`),
			topic:    contractEvents.TopicAuthLogin,
			fixture:  "auth-login.json",
			required: []string{"user", "ip", "success"},
		},
		{
			name:     "firmware", // unverified: regex based on format extrapolation, not a captured sample
			record:   testParsed("ndm", "Firmware::Manager: new firmware version 4.2.0 is available"),
			topic:    contractEvents.TopicFirmwareAvailable,
			fixture:  "firmware-available.json",
			required: []string{"version"},
		},
		{
			name:     "dns", // unverified: regex based on format extrapolation, not a captured sample
			record:   testParsed("ndm", "Dns::Manager: static resolver list changed: 192.0.2.53"),
			topic:    contractEvents.TopicNetDnsChanged,
			fixture:  "net-dns-changed.json",
			required: []string{"resolvers"},
		},
		{
			name:     "dhcp",
			record:   testParsed("ndm", `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`),
			topic:    contractEvents.TopicNetDhcpLease,
			required: []string{"mac", "ip", "hostname", "action"},
		},
		{
			name:     "wifi",
			record:   testParsed("hostapd", `Associated: 00:11:22:33:44:55 (5ghz, SSID "mndw", WifiMaster0)`),
			topic:    contractEvents.TopicWifiClientJoin,
			fixture:  "wifi-client-join.json",
			required: []string{"mac", "band", "ssid", "iface"},
		},
		{
			name:     "wifi-leave",
			record:   testParsed("kernel", `Disassociated: 00:11:22:33:44:55 (5ghz, SSID "mndw", WifiMaster0)`),
			topic:    contractEvents.TopicWifiClientLeave,
			fixture:  "wifi-client-leave.json",
			required: []string{"mac", "band", "ssid", "iface"},
		},
	}

	normalizer := fixedNormalizer()
	extractors := DefaultExtractors()

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var extracted *ExtractedEvent

			for _, extractor := range extractors {
				if candidate := extractor(tc.record); candidate != nil {
					extracted = candidate

					break
				}
			}

			if extracted == nil {
				t.Fatal("expected extractor match")
			}

			if extracted.Topic != tc.topic {
				t.Fatalf("topic = %s, want %s", extracted.Topic, tc.topic)
			}

			event, err := normalizer.NormalizeLog(extracted.Topic, extracted.Payload, testParsedTime)
			if err != nil {
				t.Fatal(err)
			}

			if event.Source != contractEvents.SourceLog || event.Topic != tc.topic {
				t.Fatalf("normalized event = %#v", event)
			}

			var payload map[string]any

			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}

			for _, key := range tc.required {
				value, ok := payload[key]

				if !ok || value == nil || value == "" {
					t.Fatalf("payload[%q] = %#v, want nonempty value", key, value)
				}
			}

			if tc.fixture != "" {
				fixtureBytes, err := os.ReadFile(filepath.Join("fixtures/valid", tc.fixture))
				if err != nil {
					t.Fatal(err)
				}

				var fixture Event

				if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
					t.Fatal(err)
				}

				if event.Topic != fixture.Topic || event.Source != contractEvents.SourceLog || string(event.Payload) != string(fixture.Payload) {
					t.Fatalf("normalized payload = %s, fixture %s = %s", event.Payload, tc.fixture, fixture.Payload)
				}
			}
		})
	}
}
