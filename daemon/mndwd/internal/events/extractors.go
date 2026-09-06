package events

import (
	"regexp"
	"strings"

	contractEvents "mndw.local/contracts/events"
)

func DefaultExtractors() []Extractor {
	return []Extractor{
		extractAuthLogin,
		extractFirmwareAvailable,
		extractDNSChanged,
		extractDHCPLease,
		extractWiFiClient,
	}
}

var dhcpAddPattern = regexp.MustCompile(
	`Dhcp::Pool: added host (\S+) \(([0-9A-Fa-f:]{17})\) "([^"]+)" to pool "([^"]*)"`,
)

func extractDHCPLease(record ParsedLogRecord) *ExtractedEvent {
	if !strings.EqualFold(record.Ident, "ndm") {
		return nil
	}

	if m := dhcpAddPattern.FindStringSubmatch(record.Message); m != nil {
		return &ExtractedEvent{
			Topic:   contractEvents.TopicNetDhcpLease,
			Payload: map[string]any{"ip": m[1], "mac": m[2], "hostname": m[3], "action": "add"},
		}
	}

	return nil
}

// unverified: regex based on format extrapolation, not a captured sample; replace with capture when available.
var dnsChangedPattern = regexp.MustCompile(
	`Dns::Manager: (?:static )?resolver list changed: (.+)`,
)

func extractDNSChanged(record ParsedLogRecord) *ExtractedEvent {
	if !strings.EqualFold(record.Ident, "ndm") {
		return nil
	}

	m := dnsChangedPattern.FindStringSubmatch(record.Message)

	if m == nil {
		return nil
	}

	parts := strings.Split(m[1], ",")
	resolvers := make([]string, 0, len(parts))

	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			resolvers = append(resolvers, trimmed)
		}
	}

	return &ExtractedEvent{
		Topic:   contractEvents.TopicNetDnsChanged,
		Payload: map[string]any{"resolvers": resolvers},
	}
}

var authSessionPattern = regexp.MustCompile(
	`Core::Security::Authority: started a user session \[(\w+)#\d+.*?@(\d+\.\d+\.\d+\.\d+)`,
)

var authFailedPattern = regexp.MustCompile(
	`Core::Security::Authority: authentication failed for user "(\w+)" from (\S+)`,
)

func extractAuthLogin(record ParsedLogRecord) *ExtractedEvent {
	if !strings.EqualFold(record.Ident, "ndm") {
		return nil
	}

	if m := authSessionPattern.FindStringSubmatch(record.Message); m != nil {
		return &ExtractedEvent{
			Topic:   contractEvents.TopicAuthLogin,
			Payload: map[string]any{"user": m[1], "ip": m[2], "success": true},
		}
	}

	if m := authFailedPattern.FindStringSubmatch(record.Message); m != nil {
		return &ExtractedEvent{
			Topic:   contractEvents.TopicAuthLogin,
			Payload: map[string]any{"user": m[1], "ip": m[2], "success": false},
		}
	}

	return nil
}

// unverified: regex based on format extrapolation, not a captured sample; replace with capture when available.
var firmwareAvailablePattern = regexp.MustCompile(
	`[Ff]irmware::Manager: new firmware version (\S+) is available`,
)

func extractFirmwareAvailable(record ParsedLogRecord) *ExtractedEvent {
	if !strings.EqualFold(record.Ident, "ndm") {
		return nil
	}

	m := firmwareAvailablePattern.FindStringSubmatch(record.Message)

	if m == nil {
		return nil
	}

	return &ExtractedEvent{
		Topic:   contractEvents.TopicFirmwareAvailable,
		Payload: map[string]any{"version": m[1]},
	}
}

var wifiAssocPattern = regexp.MustCompile(
	`(?i)(Associated|Disassociated): ([0-9A-Fa-f:]{17}) \(([^,]+), SSID "([^"]+)", (\S+)\)`,
)

func extractWiFiClient(record ParsedLogRecord) *ExtractedEvent {
	m := wifiAssocPattern.FindStringSubmatch(record.Message)

	if m == nil {
		return nil
	}

	topic := contractEvents.TopicWifiClientJoin

	if strings.EqualFold(m[1], "Disassociated") {
		topic = contractEvents.TopicWifiClientLeave
	}

	return &ExtractedEvent{
		Topic:   topic,
		Payload: map[string]any{"mac": m[2], "band": m[3], "ssid": m[4], "iface": m[5]},
	}
}
