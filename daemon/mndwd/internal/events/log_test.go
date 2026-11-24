package events

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/rcisession/proxy"
)

func TestLogPollerConfigConstructor(t *testing.T) {
	normalizer := fixedNormalizer()
	parser := NewLogParser(normalizer, time.UTC, nil, eventsTestLogger())
	publisher := &hookEventPublisher{}
	tick := make(chan time.Time, 1)

	poller := NewLogPoller(LogPollerConfig{
		Source:    newFakeLogProcess(),
		Parser:    parser,
		Publisher: publisher,
		Ticker:    tick,
		Logger:    eventsTestLogger(),
	})

	if poller == nil {
		t.Fatal("expected non-nil poller")
	}
}

type fakeLogProcessResult struct {
	records            map[string]RawLogRecord
	err                error
	blockUntilCanceled bool
}

type fakeLogProcess struct {
	mu           sync.Mutex
	results      map[string][]fakeLogProcessResult
	indexes      map[string]int
	calls        []string
	called       chan string
	stopCount    int
	stopErr      error
	stopCtxErr   error
	stopDeadline time.Time
}

func newFakeLogProcess() *fakeLogProcess {
	return &fakeLogProcess{results: map[string][]fakeLogProcessResult{}, indexes: map[string]int{}}
}

func (p *fakeLogProcess) queue(method string, results ...fakeLogProcessResult) {
	p.results[method] = results
}

func (p *fakeLogProcess) take(ctx context.Context, method string) (map[string]RawLogRecord, error) {
	p.mu.Lock()

	p.calls = append(p.calls, method)
	index := p.indexes[method]
	p.indexes[method] = index + 1
	var result fakeLogProcessResult

	if index < len(p.results[method]) {
		result = p.results[method][index]
	}

	called := p.called

	p.mu.Unlock()

	if err := ctx.Err(); err != nil {
		if called != nil {
			called <- method
		}

		return nil, err
	}

	if result.err != nil {
		if called != nil {
			called <- method
		}

		return nil, result.err
	}

	if result.blockUntilCanceled {
		if called != nil {
			called <- method
		}

		<-ctx.Done()

		return nil, ctx.Err()
	}

	if result.records == nil {
		if called != nil {
			called <- method
		}

		return map[string]RawLogRecord{}, nil
	}

	if called != nil {
		called <- method
	}

	return result.records, nil
}

func (p *fakeLogProcess) Start(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.take(ctx, "start")
}

func (p *fakeLogProcess) Next(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.take(ctx, "next")
}

func (p *fakeLogProcess) Tail(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.take(ctx, "tail")
}

func (p *fakeLogProcess) Stop(ctx context.Context) error {
	p.mu.Lock()

	p.stopCount++
	p.stopCtxErr = ctx.Err()
	p.stopDeadline, _ = ctx.Deadline()
	err := p.stopErr
	called := p.called
	p.calls = append(p.calls, "stop")

	p.mu.Unlock()

	if called != nil {
		called <- "stop"
	}

	return err
}

func (p *fakeLogProcess) callList() []string {
	p.mu.Lock()

	defer p.mu.Unlock()

	return append([]string(nil), p.calls...)
}

func processResult(records map[string]RawLogRecord) fakeLogProcessResult {
	return fakeLogProcessResult{records: records}
}

func readerRecord(id int) map[string]RawLogRecord {
	return map[string]RawLogRecord{strconv.Itoa(id): {Ident: "ndm", Message: RawLogMessage{Message: strconv.Itoa(id)}}}
}

func readerRecords(ids ...int) map[string]RawLogRecord {
	result := make(map[string]RawLogRecord, len(ids))

	for _, id := range ids {
		result[strconv.Itoa(id)] = RawLogRecord{Ident: "ndm", Message: RawLogMessage{Message: strconv.Itoa(id)}}
	}

	return result
}

func readerParser() *LogParser {
	return NewLogParser(fixedNormalizer(), time.UTC, []Extractor{
		func(record ParsedLogRecord) *ExtractedEvent {
			return &ExtractedEvent{
				Topic:   contractEvents.TopicAuthLogin,
				Payload: contractEvents.AuthLoginPayload{User: record.Message, IP: "192.0.2.10", Success: true},
			}
		},
	}, eventsTestLogger())
}

func newTestLogReader(process *fakeLogProcess, publisher Publisher, ticker <-chan time.Time, logger *slog.Logger) *LogPoller {
	return NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    readerParser(),
		Publisher: publisher,
		Ticker:    ticker,
		Logger:    logger,
	})
}

func TestLogReaderSeedsThenPublishesNewRecords(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecords(10, 11)))
	process.queue("next", processResult(readerRecords(12, 13)))

	publisher := &hookEventPublisher{}
	ticker := make(chan time.Time, 1)
	parser := readerParser()
	reader := NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    parser,
		Publisher: publisher,
		Ticker:    ticker,
		Logger:    eventsTestLogger(),
	})
	observedAt := time.Date(2026, time.November, 24, 12, 0, 0, 0, time.UTC)

	if highID, seeded := parser.HighID(); seeded || highID != 0 {
		t.Fatalf("unseeded cursor = (%d, %t), want (0, false)", highID, seeded)
	}

	if err := reader.Poll(context.Background(), observedAt); err != nil {
		t.Fatal(err)
	}

	if highID, seeded := parser.HighID(); !seeded || highID != 11 {
		t.Fatalf("seed cursor = (%d, %t), want (11, true)", highID, seeded)
	}

	if len(publisher.events) != 0 {
		t.Fatalf("seed published %d events, want none", len(publisher.events))
	}

	if err := reader.Poll(context.Background(), observedAt.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 2 {
		t.Fatalf("published %d events, want 2", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next" {
		t.Fatalf("process calls = %s, want start,next", got)
	}
}

func TestLogReaderRestartsAfterGonePublishesOnce(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecords(1, 2)), processResult(readerRecords(1, 2, 3)))
	process.queue("next", fakeLogProcessResult{err: ErrLogProcessGone})

	publisher := &hookEventPublisher{}
	reader := newTestLogReader(process, publisher, make(chan time.Time), eventsTestLogger())

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 1 {
		t.Fatalf("restart published %d events, want 1", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next,start" {
		t.Fatalf("process calls = %s, want start,next,start", got)
	}
}

func TestLogReaderBackfillsGap(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecord(1)))
	process.queue("next", processResult(readerRecord(4)))
	process.queue("tail", processResult(readerRecords(2, 3, 4)))

	publisher := &hookEventPublisher{}
	reader := newTestLogReader(process, publisher, make(chan time.Time), eventsTestLogger())

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 3 {
		t.Fatalf("backfill published %d events, want 3", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next,tail" {
		t.Fatalf("process calls = %s, want start,next,tail", got)
	}
}

func TestLogReaderBackfillsRestartSnapshotGap(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecord(1)), processResult(readerRecord(5)))
	process.queue("next", fakeLogProcessResult{err: ErrLogProcessGone})
	process.queue("tail", processResult(readerRecords(2, 3, 4, 5)))

	publisher := &hookEventPublisher{}
	reader := newTestLogReader(process, publisher, make(chan time.Time), eventsTestLogger())

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 4 {
		t.Fatalf("restart backfill published %d events, want 4", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next,start,tail" {
		t.Fatalf("process calls = %s, want start,next,start,tail", got)
	}
}

func TestLogReaderRetriesEmptyStartBeforeNextDelta(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(map[string]RawLogRecord{}), processResult(readerRecord(1)))
	process.queue("next", processResult(readerRecord(2)))

	publisher := &hookEventPublisher{}
	parser := readerParser()
	reader := NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    parser,
		Publisher: publisher,
		Ticker:    make(chan time.Time),
		Logger:    eventsTestLogger(),
	})

	for range 2 {
		if err := reader.Poll(context.Background(), time.Now()); err != nil {
			t.Fatal(err)
		}
	}

	if got := strings.Join(process.callList(), ","); got != "start,start" {
		t.Fatalf("process calls = %s, want start,start", got)
	}

	if len(publisher.events) != 0 {
		t.Fatalf("empty-start retry published %d events, want none", len(publisher.events))
	}

	if highID, seeded := parser.HighID(); !seeded || highID != 1 {
		t.Fatalf("retry cursor = (%d, %t), want (1, true)", highID, seeded)
	}
}

func TestLogReaderWarnsWhenGapRemains(t *testing.T) {
	output := &lockedLogBuffer{}
	logger := slog.New(slog.NewTextHandler(output, nil))
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecord(1)))
	process.queue("next", processResult(readerRecord(8)))
	process.queue("tail", processResult(readerRecords(5, 8)))

	reader := newTestLogReader(process, &hookEventPublisher{}, make(chan time.Time), logger)

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	logText := output.String()

	if strings.Count(logText, "device log gap remains") != 1 || !strings.Contains(logText, "from=2") || !strings.Contains(logText, "to=4") {
		t.Fatalf("gap warning = %q, want one warning for ids 2 through 4", logText)
	}
}

func TestLogReaderDoesNotWarnGapAfterSentinelReset(t *testing.T) {
	output := &lockedLogBuffer{}
	logger := slog.New(slog.NewTextHandler(output, nil))
	process := newFakeLogProcess()
	changedSentinel := RawLogRecord{Ident: "ndm", Message: RawLogMessage{Message: "new generation"}}
	restartSnapshot := map[string]RawLogRecord{
		"10": changedSentinel,
		"20": {Ident: "ndm", Message: RawLogMessage{Message: "20"}},
	}

	process.queue("start", processResult(readerRecord(10)), processResult(restartSnapshot))
	process.queue("next", fakeLogProcessResult{err: ErrLogProcessGone})
	process.queue("tail", processResult(restartSnapshot))

	reader := NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    NewLogParser(fixedNormalizer(), time.UTC, nil, logger),
		Publisher: &hookEventPublisher{},
		Ticker:    make(chan time.Time),
		Logger:    logger,
	})

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	logText := output.String()

	if !strings.Contains(logText, "device log cursor reset") {
		t.Fatalf("log output = %q, want cursor reset warning", logText)
	}

	if strings.Contains(logText, "device log gap remains") {
		t.Fatalf("log output = %q, want no gap warning after cursor reset", logText)
	}
}

func TestLogReaderResyncsWhenDeltaGoesBackwards(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(readerRecord(10)), processResult(readerRecords(1, 2)))
	process.queue("next", processResult(readerRecord(9)))

	publisher := &hookEventPublisher{}
	reader := newTestLogReader(process, publisher, make(chan time.Time), eventsTestLogger())

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 2 {
		t.Fatalf("resync published %d events, want 2 snapshot events", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next,start" {
		t.Fatalf("process calls = %s, want start,next,start", got)
	}
}

func TestLogReaderIgnoresRepeatedUpdate(t *testing.T) {
	process := newFakeLogProcess()

	process.queue("start", processResult(map[string]RawLogRecord{
		"1": {Ident: "ndm", Message: RawLogMessage{Message: "1", Repeated: 1}},
	}))
	process.queue("next", processResult(map[string]RawLogRecord{
		"1": {Ident: "ndm", Message: RawLogMessage{Message: "1", Repeated: 2}},
	}))

	publisher := &hookEventPublisher{}
	reader := newTestLogReader(process, publisher, make(chan time.Time), eventsTestLogger())

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := reader.Poll(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 0 {
		t.Fatalf("repeated update published %d events, want none", len(publisher.events))
	}

	if got := strings.Join(process.callList(), ","); got != "start,next" {
		t.Fatalf("process calls = %s, want start,next", got)
	}
}

func TestLogParserSeedsFirstPollWithoutEmittingEvents(t *testing.T) {
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger())
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
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger())
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
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger())
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
	parser := NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger())
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
	}, eventsTestLogger())
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

	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	busEvents := subscription.Events()

	now := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)
	process := newFakeLogProcess()

	process.queue("start", processResult(map[string]RawLogRecord{
		"100": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", ID: 100, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
	}))
	process.queue("next", processResult(map[string]RawLogRecord{
		"100": {Timestamp: "Sep  5 10:00:00", Ident: "ndm", ID: 100, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Core::Security::Authority: authentication failed for user "admin" from 192.0.2.10`}},
		"101": {Timestamp: "Sep  5 10:00:10", Ident: "ndm", ID: 101, Message: RawLogMessage{Level: "Info", Label: "I", Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`}},
	}))

	poller := NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Publisher: bus,
		Logger:    eventsTestLogger(),
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

	if got := strings.Join(process.callList(), ","); got != "start,next" {
		t.Fatalf("process calls = %s, want start,next", got)
	}
}

func TestLogReaderDeletesProcessOnStop(t *testing.T) {
	ticks := make(chan time.Time, 1)
	process := newFakeLogProcess()
	process.called = make(chan string, 4)
	process.stopErr = errors.New("DELETE failed")

	process.queue("start", processResult(readerRecord(1)))
	process.queue("next", processResult(map[string]RawLogRecord{}))

	poller := NewLogPoller(LogPollerConfig{
		Source: process,
		Parser: NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Ticker: ticks,
		Logger: eventsTestLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitProcessCall(t, process.called, "start")

	ticks <- time.Now()

	waitProcessCall(t, process.called, "next")

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after cancellation")
	}

	process.mu.Lock()

	stopCount := process.stopCount
	stopCtxErr := process.stopCtxErr
	stopDeadline := process.stopDeadline

	process.mu.Unlock()

	remaining := time.Until(stopDeadline)

	if stopCount != 1 || stopCtxErr != nil || remaining <= 0 || remaining > 2*time.Second {
		t.Fatalf("stop count=%d context error=%v deadline=%v; want one live bounded cleanup", stopCount, stopCtxErr, stopDeadline)
	}
}

func TestLogReaderDeletesProcessWhenGetIsCanceled(t *testing.T) {
	ticks := make(chan time.Time, 1)
	process := newFakeLogProcess()
	process.called = make(chan string, 4)

	process.queue("start", processResult(readerRecord(1)))
	process.queue("next", fakeLogProcessResult{blockUntilCanceled: true})

	poller := NewLogPoller(LogPollerConfig{
		Source: process,
		Parser: readerParser(),
		Ticker: ticks,
		Logger: eventsTestLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitProcessCall(t, process.called, "start")

	ticks <- time.Now()

	waitProcessCall(t, process.called, "next")
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after canceling in-flight GET")
	}

	process.mu.Lock()

	stopCount := process.stopCount

	process.mu.Unlock()

	if stopCount != 1 {
		t.Fatalf("stop count = %d, want 1 after canceling in-flight GET", stopCount)
	}
}

func TestLogReaderDeletesProcessWhenStartIsCanceled(t *testing.T) {
	process := newFakeLogProcess()
	process.called = make(chan string, 3)

	process.queue("start", fakeLogProcessResult{blockUntilCanceled: true})

	poller := NewLogPoller(LogPollerConfig{
		Source: process,
		Parser: readerParser(),
		Ticker: make(chan time.Time),
		Logger: eventsTestLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitProcessCall(t, process.called, "start")
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after canceling in-flight start")
	}

	process.mu.Lock()

	stopCount := process.stopCount

	process.mu.Unlock()

	if stopCount != 1 {
		t.Fatalf("stop count = %d, want 1 after canceling in-flight start", stopCount)
	}
}

func TestLogReaderNoRequestsWithoutSession(t *testing.T) {
	process := newFakeLogProcess()
	ticks := make(chan time.Time, 1)
	fallback := make(chan time.Time, 1)
	checks := make(chan struct{}, 4)
	poller := NewLogPoller(LogPollerConfig{
		Source:         process,
		Parser:         NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Ticker:         ticks,
		FallbackTicker: fallback,
		SessionPresent: func() bool {
			checks <- struct{}{}

			return false
		},
		Logger: eventsTestLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitSessionCheck(t, checks)

	fallback <- time.Now()

	waitSessionCheck(t, checks)

	if calls := process.callList(); len(calls) != 0 {
		t.Fatalf("process calls without session = %v, want none", calls)
	}

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop after cancellation")
	}
}

func TestLogPollerRunContinuesAfterPollError(t *testing.T) {
	ticks := make(chan time.Time, 3)
	process := newFakeLogProcess()
	process.called = make(chan string, 8)

	process.queue("start", fakeLogProcessResult{err: errors.New("temporary RCI failure")}, processResult(readerRecord(100)))
	process.queue("next", processResult(map[string]RawLogRecord{}), processResult(map[string]RawLogRecord{
		"100": readerRecords(100)["100"],
		"101": {
			Timestamp: "Sep  5 10:00:10",
			Ident:     "ndm",
			ID:        101,
			Message:   RawLogMessage{Message: `Dhcp::Pool: added host 192.0.2.42 (AA:BB:CC:DD:EE:FF) "phone" to pool "Home"`},
		},
	}))

	bus := NewBus()
	filter, _ := ParseTopicFilter([]string{"*"})
	subscription, err := bus.SubscribeHandle(filter)
	if err != nil {
		t.Fatal(err)
	}

	defer subscription.Cancel()

	busEvents := subscription.Events()

	poller := NewLogPoller(LogPollerConfig{
		Source:    process,
		Parser:    NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Publisher: bus,
		Ticker:    ticks,
		Logger:    eventsTestLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitProcessCall(t, process.called, "start")

	ticks <- time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)

	waitProcessCall(t, process.called, "start")

	ticks <- time.Date(2026, time.September, 5, 10, 0, 10, 0, time.UTC)

	waitProcessCall(t, process.called, "next")

	ticks <- time.Date(2026, time.September, 5, 10, 0, 20, 0, time.UTC)

	waitProcessCall(t, process.called, "next")

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

type lockedLogBuffer struct {
	mu      sync.Mutex
	content strings.Builder
	writes  chan string
}

func (b *lockedLogBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()

	defer b.mu.Unlock()

	n, err := b.content.Write(data)

	if b.writes != nil {
		select {
		case b.writes <- string(data):
		default:
		}
	}

	return n, err
}

func (b *lockedLogBuffer) String() string {
	b.mu.Lock()

	defer b.mu.Unlock()

	return b.content.String()
}

func TestLogPollerWaitsForSessionMutationAndFallback(t *testing.T) {
	output := &lockedLogBuffer{writes: make(chan string, 8)}
	logger := slog.New(slog.NewTextHandler(output, nil))
	process := newFakeLogProcess()
	process.called = make(chan string, 8)

	process.queue("start",
		fakeLogProcessResult{err: proxy.ErrNoSession},
		processResult(readerRecord(1)),
		processResult(readerRecord(2)),
	)

	present := atomic.Bool{}

	present.Store(true)

	wake := make(chan struct{}, 1)
	ticks := make(chan time.Time, 16)
	fallback := make(chan time.Time, 1)
	timezoneQueries := atomic.Int32{}
	poller := NewLogPoller(LogPollerConfig{
		Source:         process,
		Parser:         NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Ticker:         ticks,
		FallbackTicker: fallback,
		Wake:           wake,
		SessionPresent: present.Load,
		OnSessionAvailable: func(context.Context) {
			timezoneQueries.Add(1)
		},
		Logger: logger,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitLogContaining(t, output.writes, "event log poller waiting for background router access")
	waitProcessCall(t, process.called, "start")

	if got := len(process.callList()); got != 1 {
		t.Fatalf("poll calls after no-session response = %d, want 1", got)
	}

	// Interval ticks do not wake an idle poller; only a mutation or fallback does.
	for range 10 {
		ticks <- time.Now()
	}

	if got := len(process.callList()); got != 1 {
		t.Fatalf("poll calls while idle = %d, want 1", got)
	}

	for len(ticks) > 0 {
		<-ticks
	}

	wake <- struct{}{}

	waitProcessCall(t, process.called, "start")

	if got := timezoneQueries.Load(); got != 2 {
		t.Fatalf("timezone queries after session mutation = %d, want 2", got)
	}

	present.Store(false)

	ticks <- time.Now()

	waitLogContaining(t, output.writes, "event log poller waiting for background router access")

	present.Store(true)

	fallback <- time.Now()

	waitProcessCall(t, process.called, "start")

	if got := timezoneQueries.Load(); got != 3 {
		t.Fatalf("timezone queries after fallback session check = %d, want 3", got)
	}

	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("poller did not stop")
	}

	if got := strings.Count(output.String(), "event log poller waiting for background router access"); got != 2 {
		t.Fatalf("waiting info count = %d, want two idle periods: %s", got, output.String())
	}

	if strings.Contains(output.String(), "level=WARN") {
		t.Fatalf("no-session response logged a warning: %s", output.String())
	}
}

func TestLogPollerLogsOneWarningAndOneRecovery(t *testing.T) {
	output := &lockedLogBuffer{}
	logger := slog.New(slog.NewTextHandler(output, nil))
	ticks := make(chan time.Time, 4)
	process := newFakeLogProcess()
	process.called = make(chan string, 8)

	process.queue("start",
		fakeLogProcessResult{err: errors.New("temporary")},
		fakeLogProcessResult{err: errors.New("still temporary")},
		processResult(readerRecord(1)),
	)

	poller := NewLogPoller(LogPollerConfig{
		Source: process,
		Parser: NewLogParser(fixedNormalizer(), time.UTC, nil, eventsTestLogger()),
		Ticker: ticks,
		Logger: logger,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() { poller.Run(ctx); close(done) }()

	waitProcessCall(t, process.called, "start")

	ticks <- time.Now()

	waitProcessCall(t, process.called, "start")

	ticks <- time.Now()

	waitProcessCall(t, process.called, "start")
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("poller did not stop")
	}

	logText := output.String()

	if got := strings.Count(logText, "event log poll failed"); got != 1 {
		t.Fatalf("poll warning count = %d, want one: %s", got, logText)
	}

	if got := strings.Count(logText, "event log poll recovered"); got != 1 {
		t.Fatalf("poll recovery count = %d, want one: %s", got, logText)
	}
}

func waitProcessCall(t *testing.T, calls <-chan string, expected string) {
	t.Helper()

	timer := time.NewTimer(time.Second)

	defer timer.Stop()

	select {
	case call := <-calls:
		if call != expected {
			t.Fatalf("process call = %q, want %q", call, expected)
		}
	case <-timer.C:
		t.Fatalf("process call %q was not observed before timeout", expected)
	}
}

func waitSessionCheck(t *testing.T, checks <-chan struct{}) {
	t.Helper()

	timer := time.NewTimer(time.Second)

	defer timer.Stop()

	select {
	case <-checks:
	case <-timer.C:
		t.Fatal("session check was not observed before timeout")
	}
}

func waitLogContaining(t *testing.T, messages <-chan string, expected string) {
	t.Helper()

	timer := time.NewTimer(time.Second)

	defer timer.Stop()

	for {
		select {
		case message := <-messages:
			if strings.Contains(message, expected) {
				return
			}
		case <-timer.C:
			t.Fatalf("log message %q was not observed before timeout", expected)
		}
	}
}
