package events

import (
	"context"
	"hash/fnv"
	"log/slog"
	"sort"
	"strconv"
	"time"

	contractEvents "mndw.local/contracts/events"
)

type RawLogMessage struct {
	Level   string `json:"level"`
	Label   string `json:"label"`
	Message string `json:"message"`
}

type RawLogRecord struct {
	Timestamp string        `json:"timestamp"`
	Ident     string        `json:"ident"`
	ID        int           `json:"id"` // wire fidelity only; parser cursor uses the log object's key
	Message   RawLogMessage `json:"message"`
}

type ParsedLogRecord struct {
	ID        int
	Timestamp time.Time
	Ident     string
	Message   string
}

type ExtractedEvent struct {
	Topic   contractEvents.Topic
	Payload map[string]any
}

type Extractor func(record ParsedLogRecord) *ExtractedEvent

type LogSource interface {
	ShowLog(context.Context) (map[string]RawLogRecord, error)
}

const LogPollInterval = 10 * time.Second

type LogPollerConfig struct {
	Source     LogSource
	Parser     *LogParser
	Publisher  Publisher
	Ticker     <-chan time.Time
	StopTicker func()
	Logger     *slog.Logger
}

type LogPoller struct {
	source     LogSource
	parser     *LogParser
	publisher  Publisher
	ticker     <-chan time.Time
	stopTicker func()
	logger     *slog.Logger
}

func NewLogPoller(cfg LogPollerConfig) *LogPoller {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	return &LogPoller{
		source:     cfg.Source,
		parser:     cfg.Parser,
		publisher:  cfg.Publisher,
		ticker:     cfg.Ticker,
		stopTicker: cfg.StopTicker,
		logger:     cfg.Logger,
	}
}

func (p *LogPoller) Poll(ctx context.Context, observedAt time.Time) error {
	records, err := p.source.ShowLog(ctx)
	if err != nil {
		return err
	}

	events, err := p.parser.Parse(records, observedAt)
	if err != nil {
		return err
	}

	for _, event := range events {
		p.publisher.Publish(event)
	}

	return nil
}

func (p *LogPoller) Run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}

	ticker := p.ticker
	stopTicker := p.stopTicker

	if ticker == nil {
		timer := time.NewTicker(LogPollInterval)
		ticker = timer.C
		stopTicker = timer.Stop
	}

	if stopTicker != nil {
		defer stopTicker()
	}

	if err := p.Poll(ctx, time.Now()); err != nil && ctx.Err() == nil {
		p.logger.Warn("event log initial poll failed", "error", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case tick, ok := <-ticker:
			if !ok {
				return
			}

			if err := p.Poll(ctx, tick); err != nil && ctx.Err() == nil {
				p.logger.Warn("event log poll failed", "error", err)
			}
		}
	}
}

type LogParser struct {
	normalizer *Normalizer
	location   *time.Location
	extractors []Extractor
	logger     *slog.Logger
	seeded     bool
	cursor     logCursor
}

type logCursor struct {
	highID      int
	sentinelID  int
	sentinelSum uint64
}

func NewLogParser(normalizer *Normalizer, location *time.Location, extractors []Extractor, logger *slog.Logger) *LogParser {
	if location == nil {
		location = time.Local
	}

	if extractors == nil {
		extractors = DefaultExtractors()
	}

	return &LogParser{
		normalizer: normalizer,
		location:   location,
		extractors: extractors,
		logger:     logger,
	}
}

func (p *LogParser) Parse(records map[string]RawLogRecord, observedAt time.Time) ([]Event, error) {
	type idRecord struct {
		id     int
		record RawLogRecord
	}

	sorted := make([]idRecord, 0, len(records))

	for rawID, record := range records {
		id, err := strconv.Atoi(rawID)
		if err != nil || id < 0 {
			if p.logger != nil {
				p.logger.Warn("discarding non-numeric device log id", "id", rawID)
			}

			continue
		}

		sorted = append(sorted, idRecord{id: id, record: record})
	}

	if len(sorted) == 0 {
		return nil, nil
	}

	sort.Slice(sorted, func(left, right int) bool { return sorted[left].id < sorted[right].id })

	byID := make(map[int]RawLogRecord, len(sorted))

	for _, entry := range sorted {
		byID[entry.id] = entry.record
	}

	maxID := sorted[len(sorted)-1].id
	sentinelID := sorted[0].id
	sentinelSum := hashLogRecord(sorted[0].record)
	reset := false

	if p.seeded {
		if maxID < p.cursor.highID {
			reset = true
		} else if previous, ok := byID[p.cursor.sentinelID]; ok && hashLogRecord(previous) != p.cursor.sentinelSum {
			reset = true
		}
	}

	seedOnly := !p.seeded
	processEntireWindow := reset

	if seedOnly {
		p.seeded = true
		p.cursor = logCursor{highID: maxID, sentinelID: sentinelID, sentinelSum: sentinelSum}

		return nil, nil
	}

	previousHighID := p.cursor.highID
	events := make([]Event, 0)

	for _, entry := range sorted {
		if !processEntireWindow && entry.id <= previousHighID {
			continue
		}

		parsed := ParsedLogRecord{
			ID:        entry.id,
			Timestamp: observedAt,
			Ident:     entry.record.Ident,
			Message:   entry.record.Message.Message,
		}

		if entry.record.Timestamp != "" {
			if timestamp := ResolveRFC3164(entry.record.Timestamp, observedAt, p.location); !timestamp.IsZero() {
				parsed.Timestamp = timestamp
			}
		}

		var extracted *ExtractedEvent

		for _, extractor := range p.extractors {
			if result := extractor(parsed); result != nil {
				extracted = result

				break
			}
		}

		if extracted == nil {
			continue
		}

		event, err := p.normalizer.NormalizeLog(extracted.Topic, extracted.Payload, parsed.Timestamp)
		if err != nil {
			return nil, err
		}

		events = append(events, event)
	}

	p.seeded = true
	p.cursor = logCursor{highID: maxID, sentinelID: sentinelID, sentinelSum: sentinelSum}

	if reset && p.logger != nil {
		p.logger.Warn("device log cursor reset", "reason", "generation changed")
	}

	return events, nil
}

func hashLogRecord(record RawLogRecord) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(record.Ident))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(record.Message.Message))

	return h.Sum64()
}

func ResolveRFC3164(value string, observedAt time.Time, location *time.Location) time.Time {
	if location == nil {
		location = time.UTC
	}

	parsed, err := time.ParseInLocation("Jan _2 15:04:05", value, location)
	if err != nil {
		return time.Time{}
	}

	best := time.Time{}
	bestDistance := time.Duration(1<<63 - 1)

	for year := observedAt.Year() - 1; year <= observedAt.Year()+1; year++ {
		candidate := time.Date(year, parsed.Month(), parsed.Day(), parsed.Hour(), parsed.Minute(), parsed.Second(), 0, location)
		distance := candidate.Sub(observedAt)

		if distance < 0 {
			distance = -distance
		}

		if distance < bestDistance {
			best = candidate
			bestDistance = distance
		}
	}

	return best
}
