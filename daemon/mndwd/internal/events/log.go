package events

import (
	"cmp"
	"context"
	"errors"
	"hash/fnv"
	"log/slog"
	"slices"
	"strconv"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/rcisession/proxy"
)

type RawLogMessage struct {
	Level    string `json:"level"`
	Label    string `json:"label"`
	Message  string `json:"message"`
	Repeated int    `json:"repeated"`
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
	Payload any
}

type Extractor func(record ParsedLogRecord) *ExtractedEvent

type LogProcess interface {
	Start(context.Context) (map[string]RawLogRecord, error)
	Next(context.Context) (map[string]RawLogRecord, error)
	Tail(context.Context) (map[string]RawLogRecord, error)
	Stop(context.Context) error
}

const (
	LogReadInterval         = 3 * time.Second
	LogStartMaxLines        = 100
	LogTailMaxLines         = 500
	LogPollFallbackInterval = 5 * time.Minute
	LogStopTimeout          = 2 * time.Second
)

type LogPollerConfig struct {
	Source             LogProcess
	Parser             *LogParser
	Publisher          Publisher
	Ticker             <-chan time.Time
	StopTicker         func()
	FallbackTicker     <-chan time.Time
	StopFallbackTicker func()
	Wake               <-chan struct{}
	SessionPresent     func() bool
	OnSessionAvailable func(context.Context)
	Logger             *slog.Logger
}

type LogPoller struct {
	source             LogProcess
	parser             *LogParser
	publisher          Publisher
	ticker             <-chan time.Time
	stopTicker         func()
	fallbackTicker     <-chan time.Time
	stopFallbackTicker func()
	wake               <-chan struct{}
	sessionPresent     func() bool
	onSessionAvailable func(context.Context)
	logger             *slog.Logger
	processLive        bool
}

func NewLogPoller(cfg LogPollerConfig) *LogPoller {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}

	return &LogPoller{
		source:             cfg.Source,
		parser:             cfg.Parser,
		publisher:          cfg.Publisher,
		ticker:             cfg.Ticker,
		stopTicker:         cfg.StopTicker,
		fallbackTicker:     cfg.FallbackTicker,
		stopFallbackTicker: cfg.StopFallbackTicker,
		wake:               cfg.Wake,
		sessionPresent:     cfg.SessionPresent,
		onSessionAvailable: cfg.OnSessionAvailable,
		logger:             cfg.Logger,
	}
}

func (p *LogPoller) Poll(ctx context.Context, observedAt time.Time) error {
	if p.source == nil {
		return errors.New("device log process unavailable")
	}

	if !p.processLive {
		return p.startAndParse(ctx, observedAt)
	}

	records, err := p.source.Next(ctx)
	if err != nil {
		if ctx.Err() == nil {
			p.processLive = false
		}

		if errors.Is(err, ErrLogProcessGone) && ctx.Err() == nil {
			return p.startAndParse(ctx, observedAt)
		}

		return err
	}

	if len(records) == 0 {
		return nil
	}

	highID, seeded := p.parser.HighID()

	if seeded {
		highestID, hasIDs := highestLogID(records)

		if hasIDs && highestID < highID {
			p.processLive = false

			return p.startAndParse(ctx, observedAt)
		}
	}

	records, pendingGap, err := p.backfillGap(ctx, records)

	if err != nil {
		if ctx.Err() == nil {
			p.processLive = false
		}

		return err
	}

	return p.parseAndPublish(records, observedAt, pendingGap)
}

func (p *LogPoller) startAndParse(ctx context.Context, observedAt time.Time) error {
	records, err := p.source.Start(ctx)
	if err != nil {
		p.processLive = ctx.Err() != nil

		return err
	}

	p.processLive = true

	if len(records) == 0 {
		p.processLive = false

		return nil
	}

	highID, seeded := p.parser.HighID()
	var pendingGap *logGap

	if seeded {
		if highestID, hasIDs := highestLogID(records); hasIDs && highestID >= highID {
			var gap *logGap
			records, gap, err = p.backfillGap(ctx, records)

			if err != nil {
				if ctx.Err() == nil {
					p.processLive = false
				}

				return err
			}

			pendingGap = gap
		}
	}

	return p.parseAndPublish(records, observedAt, pendingGap)
}

func (p *LogPoller) parseAndPublish(records map[string]RawLogRecord, observedAt time.Time, pendingGap *logGap) error {
	events, reset, err := p.parser.parseWithReset(records, observedAt)
	if err != nil {
		p.processLive = false

		return err
	}

	if pendingGap != nil && !reset {
		p.logger.Warn("device log gap remains", "from", pendingGap.from, "to", pendingGap.to)
	}

	for _, event := range events {
		p.publisher.Publish(event)
	}

	return nil
}

func highestLogID(records map[string]RawLogRecord) (int, bool) {
	maximum := 0
	found := false

	for rawID := range records {
		id, err := strconv.Atoi(rawID)
		if err != nil || id < 0 {
			continue
		}

		if !found || id > maximum {
			maximum = id
		}

		found = true
	}

	return maximum, found
}

func lowestIDAbove(records map[string]RawLogRecord, highID int) (int, bool) {
	lowest := 0
	found := false

	for rawID := range records {
		id, err := strconv.Atoi(rawID)
		if err != nil || id <= highID {
			continue
		}

		if !found || id < lowest {
			lowest = id
		}

		found = true
	}

	return lowest, found
}

type logGap struct {
	from int
	to   int
}

func (p *LogPoller) backfillGap(ctx context.Context, records map[string]RawLogRecord) (map[string]RawLogRecord, *logGap, error) {
	highID, seeded := p.parser.HighID()

	if !seeded {
		return records, nil, nil
	}

	highestID, hasIDs := highestLogID(records)

	if !hasIDs || highestID < highID {
		return records, nil, nil
	}

	lowestNewID, hasNewID := lowestIDAbove(records, highID)

	if !hasNewID || lowestNewID <= highID+1 {
		return records, nil, nil
	}

	missingFrom := highID + 1
	missingTo := lowestNewID - 1
	tail, err := p.source.Tail(ctx)
	if err != nil {
		return nil, nil, err
	}

	if tailLowestNewID, tailHasNewID := lowestIDAbove(tail, highID); tailHasNewID {
		missingTo = min(missingTo, tailLowestNewID-1)
	}

	var gap *logGap

	if missingFrom <= missingTo {
		gap = &logGap{from: missingFrom, to: missingTo}
	}

	return tail, gap, nil
}

func (p *LogPoller) Run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}

	defer func() {
		if !p.processLive || p.source == nil {
			return
		}

		p.processLive = false
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), LogStopTimeout)

		defer cancel()

		_ = p.source.Stop(stopCtx)
	}()

	ticker := p.ticker
	stopTicker := p.stopTicker

	if ticker == nil {
		timer := time.NewTicker(LogReadInterval)
		ticker = timer.C
		stopTicker = timer.Stop
	}

	if stopTicker != nil {
		defer stopTicker()
	}

	fallbackTicker := p.fallbackTicker
	stopFallbackTicker := p.stopFallbackTicker

	if fallbackTicker == nil {
		timer := time.NewTicker(LogPollFallbackInterval)
		fallbackTicker = timer.C
		stopFallbackTicker = timer.Stop
	}

	if stopFallbackTicker != nil {
		defer stopFallbackTicker()
	}

	active := p.sessionPresent == nil
	waiting := false
	warned := false
	setWaiting := func() {
		active = false
		p.processLive = false

		if !waiting {
			p.logger.Info("event log poller waiting for background router access")

			waiting = true
		}
	}
	poll := func(observedAt time.Time) {
		starting := false

		if p.sessionPresent != nil {
			if !p.sessionPresent() {
				setWaiting()

				return
			}

			if !active {
				if p.onSessionAvailable != nil {
					p.onSessionAvailable(ctx)
				}

				starting = true
			}
		}

		err := p.Poll(ctx, observedAt)
		if errors.Is(err, proxy.ErrNoSession) && p.sessionPresent != nil {
			setWaiting()

			return
		}

		if starting {
			active = true
			waiting = false
		}

		if err != nil && ctx.Err() == nil {
			if !warned {
				p.logger.Warn("event log poll failed", "error", err)

				warned = true
			}

			return
		}

		if err == nil && warned {
			p.logger.Info("event log poll recovered")

			warned = false
		}
	}

	if p.sessionPresent != nil && !p.sessionPresent() {
		setWaiting()
	} else {
		active = p.sessionPresent == nil

		poll(time.Now())
	}

	for {
		if !active {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-p.wake:
				if p.wake == nil {
					continue
				}

				if !ok {
					return
				}

				poll(time.Now())
			case tick, ok := <-fallbackTicker:
				if !ok {
					return
				}

				poll(tick)
			}

			continue
		}

		select {
		case <-ctx.Done():
			return
		case tick, ok := <-ticker:
			if !ok {
				return
			}

			poll(tick)
		case _, ok := <-p.wake:
			if p.wake != nil && !ok {
				return
			}

			poll(time.Now())
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
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

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

func (p *LogParser) SetLocation(location *time.Location) {
	if location != nil {
		p.location = location
	}
}

func (p *LogParser) HighID() (int, bool) {
	return p.cursor.highID, p.seeded
}

func (p *LogParser) Parse(records map[string]RawLogRecord, observedAt time.Time) ([]Event, error) {
	events, _, err := p.parseWithReset(records, observedAt)

	return events, err
}

func (p *LogParser) parseWithReset(records map[string]RawLogRecord, observedAt time.Time) ([]Event, bool, error) {
	type idRecord struct {
		id     int
		record RawLogRecord
	}

	sorted := make([]idRecord, 0, len(records))

	for rawID, record := range records {
		id, err := strconv.Atoi(rawID)
		if err != nil || id < 0 {
			p.logger.Warn("discarding non-numeric device log id", "id", rawID)

			continue
		}

		sorted = append(sorted, idRecord{id: id, record: record})
	}

	if len(sorted) == 0 {
		return nil, false, nil
	}

	slices.SortFunc(sorted, func(left, right idRecord) int { return cmp.Compare(left.id, right.id) })

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

		return nil, false, nil
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
			return nil, false, err
		}

		events = append(events, event)
	}

	p.seeded = true
	p.cursor = logCursor{highID: maxID, sentinelID: sentinelID, sentinelSum: sentinelSum}

	if reset {
		p.logger.Warn("device log cursor reset", "reason", "generation changed")
	}

	return events, reset, nil
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
