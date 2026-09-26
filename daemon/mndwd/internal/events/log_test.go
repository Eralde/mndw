package events

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	rci "mndw.local/rci"
)

func TestLogPollerConfigConstructor(t *testing.T) {
	normalizer := fixedNormalizer()
	parser := NewLogParser(normalizer, time.UTC, nil, nil)
	publisher := &hookEventPublisher{}
	tick := make(chan time.Time, 1)

	poller := NewLogPoller(LogPollerConfig{
		Source:    &fakeLogSource{calls: []map[string]RawLogRecord{{}}},
		Parser:    parser,
		Publisher: publisher,
		Ticker:    tick,
	})

	if poller == nil {
		t.Fatal("expected non-nil poller")
	}
}

type fakeLogSource struct {
	calls []map[string]RawLogRecord
	errs  []error
	index int
}

func (s *fakeLogSource) ShowLog(ctx context.Context) (map[string]RawLogRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if s.index < len(s.errs) && s.errs[s.index] != nil {
		err := s.errs[s.index]
		s.index++

		return nil, err
	}

	if s.index >= len(s.calls) {
		return map[string]RawLogRecord{}, nil
	}

	result := s.calls[s.index]
	s.index++

	return result, nil
}

func TestLogParserSeedsFirstPollWithoutEmittingEvents(t *testing.T) {
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, nil)
	observed := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)
	initial := map[string]RawLogRecord{
		"10": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
		"11": {Timestamp: "Sep  5 10:00:01", Ident: "ndm", Message: RawLogMessage{Message: "Firmware::Manager: new firmware version 4.3.1 is available"}},
	}

	events, err := parser.Parse(initial, observed)
	if err != nil {
		t.Fatalf("seed parse error: %v", err)
	}

	if len(events) != 0 {
		t.Fatalf("seed parse = %#v, want 0 events", events)
	}

	updated := map[string]RawLogRecord{
		"10": initial["10"],
		"11": initial["11"],
		"12": {Timestamp: "Sep  5 10:00:02", Ident: "ndm", Message: RawLogMessage{Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
	}
	events, err = parser.Parse(updated, observed.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}

	if len(events) != 1 || events[0].Topic != contractEvents.TopicNetDhcpLease {
		t.Fatalf("new events = %#v", events)
	}
}

func TestLogParserResetsOnNumericIDRegression(t *testing.T) {
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, nil)
	seed := map[string]RawLogRecord{
		"20": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
	}

	if _, err := parser.Parse(seed, time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	first := map[string]RawLogRecord{
		"20": seed["20"],
		"21": {Timestamp: "Sep  5 10:00:01", Ident: "ndm", Message: RawLogMessage{Message: "Firmware::Manager: new firmware version 4.3.1 is available"}},
	}

	if _, err := parser.Parse(first, time.Date(2026, time.September, 5, 10, 0, 1, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	second := map[string]RawLogRecord{
		"1": {Timestamp: "Sep  5 10:00:02", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.0.2.10:Home/ agent Chrome`}},
		"2": {Timestamp: "Sep  5 10:00:03", Ident: "ndm", Message: RawLogMessage{Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
	}
	events, err := parser.Parse(second, time.Date(2026, time.September, 5, 10, 0, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}

	if len(events) != 2 {
		t.Fatalf("reset events = %#v, want 2 records", events)
	}
}

func TestLogParserResetsOnOverlappingSentinel(t *testing.T) {
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, nil)
	observed := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

	seed := map[string]RawLogRecord{
		"10": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
		"11": {Timestamp: "Sep  5 10:00:01", Ident: "ndm", Message: RawLogMessage{Message: "Firmware::Manager: new firmware version 4.3.1 is available"}},
	}

	if _, err := parser.Parse(seed, observed); err != nil {
		t.Fatalf("seed parse: %v", err)
	}

	first := map[string]RawLogRecord{
		"10": seed["10"],
		"11": seed["11"],
		"12": {Timestamp: "Sep  5 10:00:02", Ident: "ndm", Message: RawLogMessage{Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
	}

	if events, err := parser.Parse(first, observed.Add(2*time.Second)); err != nil || len(events) != 1 {
		t.Fatalf("first parse = %#v, %v", events, err)
	}

	rotated := map[string]RawLogRecord{
		"9":  {Timestamp: "Sep  5 10:00:03", Ident: "ndm", Message: RawLogMessage{Message: "Dns::Manager: static resolver list changed: 192.0.2.53"}},
		"10": {Timestamp: "Sep  5 10:00:04", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.0.2.10:Home/ agent Chrome`}},
		"11": {Timestamp: "Sep  5 10:00:05", Ident: "ndm", Message: RawLogMessage{Message: "Firmware::Manager: new firmware version 4.3.1 is available"}},
		"12": {Timestamp: "Sep  5 10:00:06", Ident: "ndm", Message: RawLogMessage{Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
	}
	events, err := parser.Parse(rotated, observed.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}

	if len(events) != 4 {
		t.Fatalf("overlapping sentinel events = %#v, want 4 records", events)
	}
}

func TestLogParserSkipsEmptyResponseAndRetainsCursor(t *testing.T) {
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, nil)
	observed := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

	seed := map[string]RawLogRecord{
		"10": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
	}

	if _, err := parser.Parse(seed, observed); err != nil {
		t.Fatalf("seed parse: %v", err)
	}

	if events, err := parser.Parse(map[string]RawLogRecord{}, observed.Add(10*time.Second)); err != nil || len(events) != 0 {
		t.Fatalf("empty parse = %#v, %v", events, err)
	}

	next := map[string]RawLogRecord{
		"11": {Timestamp: "Sep  5 10:00:11", Ident: "ndm", Message: RawLogMessage{Message: "Firmware::Manager: new firmware version 4.3.1 is available"}},
	}
	events, err := parser.Parse(next, observed.Add(11*time.Second))
	if err != nil || len(events) != 1 {
		t.Fatalf("post-empty parse = %#v, %v", events, err)
	}
}

func TestLogParserUsesObjectKeyAsCursorID(t *testing.T) {
	var parsedID int
	parser := NewLogParser(fixedNormalizer(), time.UTC, []Extractor{
		func(record ParsedLogRecord) *ExtractedEvent {
			parsedID = record.ID

			return &ExtractedEvent{
				Topic:   contractEvents.TopicAuthLogin,
				Payload: contractEvents.AuthLoginPayload{User: "admin", IP: "192.0.2.10", Success: false},
			}
		},
	}, nil)
	observed := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

	// Seed with a different record so cursor is established.
	seed := RawLogRecord{ID: 5, Ident: "ndm", Message: RawLogMessage{Message: "unmatched"}}

	if _, err := parser.Parse(map[string]RawLogRecord{"5": seed}, observed); err != nil {
		t.Fatal(err)
	}

	record := RawLogRecord{ID: 999, Ident: "ndm", Message: RawLogMessage{Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}}

	if _, err := parser.Parse(map[string]RawLogRecord{"5": seed, "10": record}, observed.Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	if parser.cursor.highID != 10 {
		t.Fatalf("cursor highID = %d, want object key 10", parser.cursor.highID)
	}

	if parsedID != 10 {
		t.Fatalf("parsed ID = %d, want object key 10", parsedID)
	}
}

func TestResolveRFC3164ChoosesNearestYearAcrossNewYear(t *testing.T) {
	location := time.FixedZone("device", 2*60*60)
	observed := time.Date(2027, time.January, 1, 0, 0, 2, 0, location)
	parsed := ResolveRFC3164("Dec 31 23:59:59", observed, location)

	if parsed.IsZero() || parsed.Year() != 2026 || parsed.Month() != time.December {
		t.Fatalf("parsed timestamp = %v", parsed)
	}

	if malformed := ResolveRFC3164("not a timestamp", observed, location); !malformed.IsZero() {
		t.Fatalf("malformed timestamp = %v, want zero", malformed)
	}
}

func TestExtractorRecognizesAuthLogin(t *testing.T) {
	record := ParsedLogRecord{
		ID:        1,
		Timestamp: time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC),
		Ident:     "ndm",
		Message:   `Core::Security::Authority: started a user session [admin#20(none) from http://{http/rci}@192.168.1.97:Home/ agent Chrome`,
	}

	var matched *ExtractedEvent

	for _, ext := range DefaultExtractors() {
		if result := ext(record); result != nil {
			matched = result

			break
		}
	}

	if matched == nil || matched.Topic != contractEvents.TopicAuthLogin {
		t.Fatalf("extraction = %#v", matched)
	}
}

func TestRawLogRecordUnmarshalsNestedMessage(t *testing.T) {
	raw := `{
		"message": {"level": "Info", "label": "I", "message": "Cifs::ServerTsmb: service started."},
		"timestamp": "Sep  5 09:55:29",
		"ident": "ndm",
		"id": 3359
	}`

	var record RawLogRecord

	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		t.Fatal(err)
	}

	if record.Message.Level != "Info" || record.Message.Label != "I" {
		t.Fatalf("nested message = %#v", record.Message)
	}

	if record.Message.Message != "Cifs::ServerTsmb: service started." {
		t.Fatalf("inner text = %q", record.Message.Message)
	}

	if record.ID != 3359 || record.Ident != "ndm" {
		t.Fatalf("record = %#v", record)
	}
}

func TestLogPollerEndToEndDecodesAndPublishes(t *testing.T) {
	bus := NewBus()
	filter, err := ParseTopicFilter([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}

	busEvents, cancelBus, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancelBus()

	now := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)
	transport := &fakeRciTransport{responses: []json.RawMessage{
		wireLogResponse(t, map[string]RawLogRecord{
			"100": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", ID: 100, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
		}),
		wireLogResponse(t, map[string]RawLogRecord{
			"100": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", ID: 100, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
			"101": {Timestamp: "Sep  5 10:00:10", Ident: "ndm", ID: 101, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
		}),
	}}
	client, err := rci.New(transport)
	if err != nil {
		t.Fatal(err)
	}

	poller := NewLogPoller(LogPollerConfig{
		Source:    NewRCILogSource(client),
		Parser:    NewLogParser(fixedNormalizer(), time.UTC, nil, nil),
		Publisher: bus,
	})

	if err := poller.Poll(context.Background(), now); err != nil {
		t.Fatal(err)
	}

	// First poll seeds the cursor without emitting events.
	select {
	case event := <-busEvents:
		t.Fatalf("seed poll emitted event: %#v", event)
	default:
	}

	if err := poller.Poll(context.Background(), now.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}

	event := <-busEvents

	if event.Topic != contractEvents.TopicNetDhcpLease || event.Source != contractEvents.SourceLog {
		t.Fatalf("incremental event = %#v", event)
	}

	for index, request := range transport.requests {
		if string(request) != `[{"show":{"log":{}}}]` {
			t.Fatalf("RCI request %d = %s", index, request)
		}
	}
}

func TestLogPollerRunStopsOnCancellation(t *testing.T) {
	ticks := make(chan time.Time)
	poller := NewLogPoller(LogPollerConfig{Source: &fakeLogSource{}, Parser: NewLogParser(fixedNormalizer(), time.UTC, nil, nil), Ticker: ticks})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after cancellation")
	}
}

func TestLogPollerRunContinuesAfterPollError(t *testing.T) {
	ticks := make(chan time.Time, 3)
	seedRecord := RawLogRecord{Timestamp: "Sep  5 10:00:00", Ident: "ndm", ID: 100, Message: RawLogMessage{Level: "Info", Label: "I", Message: "Firmware::Manager: new firmware version 4.3.1 is available"}}
	// Run calls Poll once immediately (seed/error), then once per tick.
	transport := &fakeRciTransport{
		errs: []error{errors.New("temporary RCI failure"), nil, nil, nil},
		responses: []json.RawMessage{
			nil,
			wireLogResponse(t, map[string]RawLogRecord{"100": seedRecord}),
			wireLogResponse(t, map[string]RawLogRecord{"100": seedRecord}),
			wireLogResponse(t, map[string]RawLogRecord{
				"100": seedRecord,
				"101": {Timestamp: "Sep  5 10:00:10", Ident: "ndm", ID: 101, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
			}),
		},
		calls: make(chan int, 4),
	}
	client, err := rci.New(transport)
	if err != nil {
		t.Fatal(err)
	}

	bus := NewBus()
	filter, _ := ParseTopicFilter([]string{"*"})
	busEvents, cancelBus, err := bus.Subscribe(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer cancelBus()

	poller := NewLogPoller(LogPollerConfig{
		Source:    NewRCILogSource(client),
		Parser:    NewLogParser(fixedNormalizer(), time.UTC, nil, nil),
		Publisher: bus,
		Ticker:    ticks,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	// Wait for the initial poll (error) from Run.
	<-transport.calls

	ticks <- time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

	<-transport.calls

	ticks <- time.Date(2026, time.September, 5, 10, 0, 10, 0, time.UTC)

	<-transport.calls

	ticks <- time.Date(2026, time.September, 5, 10, 0, 20, 0, time.UTC)

	<-transport.calls

	if event := <-busEvents; event.Topic != contractEvents.TopicNetDhcpLease {
		t.Fatalf("recovery event = %#v", event)
	}

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after recovery test cancellation")
	}
}

type fakeRciTransport struct {
	responses []json.RawMessage
	errs      []error
	requests  [][]byte
	calls     chan int
	index     int
}

func wireLogResponse(t *testing.T, records map[string]RawLogRecord) json.RawMessage {
	t.Helper()

	result, err := json.Marshal(map[string]any{"show": map[string]any{"log": records}})
	if err != nil {
		t.Fatal(err)
	}

	wire, err := json.Marshal([]json.RawMessage{result})
	if err != nil {
		t.Fatal(err)
	}

	return wire
}

func (t *fakeRciTransport) Send(_ context.Context, body []byte) (rci.Response, error) {
	t.requests = append(t.requests, append([]byte(nil), body...))
	index := t.index
	t.index++

	if t.calls != nil {
		t.calls <- index
	}

	if index < len(t.errs) && t.errs[index] != nil {
		return rci.Response{}, t.errs[index]
	}

	if index >= len(t.responses) || t.responses[index] == nil {
		return rci.Response{}, errors.New("fake RCI response exhausted")
	}

	return rci.Response{Status: 200, Body: t.responses[index]}, nil
}
