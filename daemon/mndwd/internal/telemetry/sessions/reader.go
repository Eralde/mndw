package sessions

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

const (
	// sessionIDPrefix prefixes a session identifier.
	sessionIDPrefix = "s1-"
	// defaultSessionPage is the default page size for session samples.
	defaultSessionPage = 200
	// maxSessionPage bounds one page of session samples.
	maxSessionPage = 1000
	// maxSessionSummaries bounds one session list.
	maxSessionSummaries = 64
	// cursorVersion is the only supported cursor version.
	cursorVersion = 1
	// cursorBytes is version + bootID + three uint64 + checksum.
	cursorBytes = 45
)

var (
	// ErrSessionNotFound reports an unknown session identifier.
	ErrSessionNotFound = errors.New("telemetry: session not found")
	// ErrCursorInvalid reports a cursor that is malformed or damaged.
	ErrCursorInvalid = errors.New("telemetry: session cursor is invalid")
	// ErrCursorExpired reports a cursor whose snapshot no longer exists.
	ErrCursorExpired = errors.New("telemetry: session cursor expired")
	// ErrSessionUnavailable reports that no validated reader can serve records.
	ErrSessionUnavailable = errors.New("telemetry: session storage unavailable")
)

// SessionSummary is one retained boot session.
type SessionSummary struct {
	ID             string `json:"id"`
	BootOrder      string `json:"bootOrder"`
	ElapsedStartMs int64  `json:"elapsedStartMs"`
	ElapsedEndMs   int64  `json:"elapsedEndMs"`
	SampleCount    int    `json:"sampleCount"`
	ConflictCount  int    `json:"conflictCount"`
	State          string `json:"state"`
	UTCStartMs     *int64 `json:"utcStartMs"`
	UTCEndMs       *int64 `json:"utcEndMs"`
}

// SessionSample is one retained sample in a session page.
type SessionSample struct {
	Sequence    string     `json:"sequence"`
	Series      uint16     `json:"series"`
	ElapsedMs   int64      `json:"elapsedMs"`
	UTCMs       *int64     `json:"utcMs"`
	Values      []*float64 `json:"values"`
	Disposition string     `json:"disposition"`
}

// SessionList is the diagnostic session index.
type SessionList struct {
	Sessions []SessionSummary `json:"sessions"`
	Storage  StorageStatus    `json:"storage"`
}

// SessionPage is one page of session samples.
type SessionPage struct {
	Samples           []SessionSample `json:"samples"`
	NextCursor        *string         `json:"nextCursor"`
	Truncated         bool            `json:"truncated"`
	TruncationReasons []string        `json:"truncationReasons"`
	Storage           StorageStatus   `json:"storage"`
}

// RecoveryIssueDTO is a JSON-safe recovery issue.
type RecoveryIssueDTO struct {
	Code          string  `json:"code"`
	FirstSequence *string `json:"firstSequence"`
	LastSequence  *string `json:"lastSequence"`
}

// CoverageDTO is a JSON-safe coverage range.
type CoverageDTO struct {
	Series       uint16   `json:"series"`
	StartMs      *int64   `json:"startMs"`
	EndMs        *int64   `json:"endMs"`
	EdgeComplete bool     `json:"edgeComplete"`
	Complete     bool     `json:"complete"`
	Reasons      []string `json:"reasons"`
}

// StorageStatus is a JSON-safe projection of storage and pipeline state.
type StorageStatus struct {
	Mode                 string             `json:"mode"`
	Issues               []RecoveryIssueDTO `json:"issues"`
	JournalBytes         *int64             `json:"journalBytes"`
	JournalLimitBytes    int64              `json:"journalLimitBytes"`
	PendingSampleCount   *int               `json:"pendingSampleCount"`
	OldestPendingSession *string            `json:"oldestPendingSession"`
	DeliveryError        *string            `json:"deliveryError"`
	Coverage             []CoverageDTO      `json:"coverage"`
	DroppedRecords       map[string]string  `json:"droppedRecords"`
}

// Reader serves bounded diagnostic sample sessions.
type Reader interface {
	List(context.Context) (SessionList, error)
	Read(ctx context.Context, id string, after string, limit int) (SessionPage, error)
}

// Status contains the pipeline fields exposed in session diagnostics.
type Status struct {
	PendingSamples int
	Error          string
	Loss           map[string]uint64
	Coverage       []journal.Coverage
}

// ParseSessionLimit validates the `limit` query parameter.
func ParseSessionLimit(values url.Values) (int, error) {
	if len(values) == 0 {
		return defaultSessionPage, nil
	}

	if len(values["limit"]) != 1 {
		return 0, errors.New("telemetry: limit must be supplied once")
	}

	if len(values) != 1 {
		return 0, errors.New("telemetry: unknown query parameter")
	}

	raw := values.Get("limit")
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxSessionPage {
		return 0, fmt.Errorf("telemetry: limit must be between 1 and %d", maxSessionPage)
	}

	return limit, nil
}

// ParseSessionID validates a session identifier and returns its boot.
func ParseSessionID(id string) (journal.BootID, error) {
	var boot journal.BootID

	if !strings.HasPrefix(id, sessionIDPrefix) {
		return boot, ErrSessionNotFound
	}

	decoded, err := hex.DecodeString(strings.TrimPrefix(id, sessionIDPrefix))
	if err != nil || len(decoded) != len(boot) {
		return boot, ErrSessionNotFound
	}

	copy(boot[:], decoded)

	if boot.IsZero() {
		return boot, ErrSessionNotFound
	}

	return boot, nil
}

// SessionID renders the identifier of one boot.
func SessionID(boot journal.BootID) string {
	return sessionIDPrefix + boot.String()
}

// cursor carries the traversal position of one session page.
type cursor struct {
	boot                journal.BootID
	inventoryGeneration uint64
	nextSequence        uint64
	snapshotThrough     uint64
}

// encodeCursor renders the canonical base64url cursor.
func encodeCursor(value cursor) string {
	raw := make([]byte, 0, cursorBytes)
	raw = append(raw, cursorVersion)
	raw = append(raw, value.boot[:]...)
	raw = binary.LittleEndian.AppendUint64(raw, value.inventoryGeneration)
	raw = binary.LittleEndian.AppendUint64(raw, value.nextSequence)
	raw = binary.LittleEndian.AppendUint64(raw, value.snapshotThrough)
	sum := crc32.Update(0, crc32.MakeTable(crc32.Castagnoli), raw[:41])
	raw = binary.LittleEndian.AppendUint32(raw, sum)

	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeCursor validates cursor syntax, version, and checksum.
func decodeCursor(encoded string, boot journal.BootID) (cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != cursorBytes {
		return cursor{}, ErrCursorInvalid
	}

	if raw[0] != cursorVersion {
		return cursor{}, ErrCursorInvalid
	}

	var value cursor

	copy(value.boot[:], raw[1:17])

	if value.boot != boot {
		return cursor{}, ErrCursorInvalid
	}

	value.inventoryGeneration = binary.LittleEndian.Uint64(raw[17:])
	value.nextSequence = binary.LittleEndian.Uint64(raw[25:])
	value.snapshotThrough = binary.LittleEndian.Uint64(raw[33:])

	sum := crc32.Update(0, crc32.MakeTable(crc32.Castagnoli), raw[:41])

	if stored := binary.LittleEndian.Uint32(raw[41:]); stored != sum {
		return cursor{}, ErrCursorInvalid
	}

	return value, nil
}

// sessionReader serves sessions from durable journal snapshots.
type sessionReader struct {
	provider journal.StorageProvider
	status   func() Status
	limits   journal.Limits
}

// NewReader builds the diagnostic session reader.
func NewReader(provider journal.StorageProvider, status func() Status, limits journal.Limits) Reader {
	if limits.Bytes == 0 {
		limits = journal.DefaultLimits()
	}

	return &sessionReader{provider: provider, status: status, limits: limits}
}

type journalProgress interface {
	DurableThrough() uint64
	Manifest() journal.Manifest
}

type readLease struct {
	reader   *journal.Reader
	progress journalProgress
	status   journal.RecoveryStatus
	close    func() error
}

func acquireReadLease(ctx context.Context, provider journal.StorageProvider) (readLease, error) {
	lease, err := provider.Acquire(ctx)
	if err != nil {
		return readLease{}, err
	}

	var progress journalProgress

	if writer := lease.Result.Writer; writer != nil {
		progress = writer
	}

	return readLease{
		reader:   lease.Result.Reader,
		progress: progress,
		status:   lease.Result.Status,
		close:    lease.Close,
	}, nil
}

// List returns retained sessions newest boot first with storage status.
func (r *sessionReader) List(ctx context.Context) (SessionList, error) {
	lease, err := acquireReadLease(ctx, r.provider)
	if err != nil {
		return SessionList{Storage: r.storageStatus(journal.RecoveryStatus{Mode: journal.StatusUnavailable})}, err
	}

	defer func() { _ = lease.close() }()

	status := r.storageStatus(lease.status)

	if lease.reader == nil {
		return SessionList{Sessions: []SessionSummary{}, Storage: status}, nil
	}

	summaries, err := r.summaries(ctx, lease.reader)
	if err != nil {
		return SessionList{Storage: status}, err
	}

	if len(summaries) > maxSessionSummaries {
		summaries = summaries[:maxSessionSummaries]
	}

	return SessionList{Sessions: summaries, Storage: status}, nil
}

// Read returns one page of a session's samples.
func (r *sessionReader) Read(ctx context.Context, id string, after string, limit int) (SessionPage, error) {
	boot, err := ParseSessionID(id)
	if err != nil {
		return SessionPage{}, err
	}

	if limit <= 0 {
		limit = defaultSessionPage
	}

	if limit > maxSessionPage {
		limit = maxSessionPage
	}

	lease, err := acquireReadLease(ctx, r.provider)
	if err != nil {
		return SessionPage{}, err
	}

	defer func() { _ = lease.close() }()

	status := r.storageStatus(lease.status)

	if lease.reader == nil {
		return SessionPage{}, ErrSessionUnavailable
	}

	var start cursor

	if after != "" {
		start, err = decodeCursor(after, boot)
		if err != nil {
			return SessionPage{}, err
		}

		if start.snapshotThrough != durableThrough(lease) || start.inventoryGeneration != generationOf(lease) {
			return SessionPage{}, ErrCursorExpired
		}
	}

	anchors := map[journal.BootID]journal.Anchor{}
	slots := map[uint64]bool{}
	var (
		samples      = []SessionSample{}
		seen         int
		reasons      = []string{}
		truncated    bool
		lastSequence uint64
		durable      = durableThrough(lease)
		generation   = generationOf(lease)
	)

	err = lease.reader.Scan(ctx, func(record journal.Record) error {
		switch record.Kind {
		case journal.KindAnchor:
			if anchor, err := journal.DecodeAnchor(record); err == nil {
				if existing, ok := anchors[anchor.Boot]; !ok || anchor.Seq >= existing.Seq {
					anchors[anchor.Boot] = anchor
				}
			}
		case journal.KindSample:
			sample, err := journal.DecodeSample(record)
			if err != nil || sample.Boot != boot {
				return nil
			}

			seen++

			if start.nextSequence > 0 && record.Seq <= start.nextSequence {
				return nil
			}

			if len(samples) >= limit {
				truncated = true
				reasons = append(reasons, "page-limit")

				return nil
			}

			key := uint64(sample.Series)*1<<40 + uint64(alignSampleSlot(sample, anchors))
			conflict := slots[key]
			slots[key] = true

			disposition := "pending"

			if record.Seq <= durable {
				disposition = "retained"
			} else if lease.progress == nil {
				disposition = "unproven"
			}

			if conflict {
				disposition = "conflict"
			}

			utc := mappedOrNil(sample, anchors)
			samples = append(samples, SessionSample{
				Sequence:    strconv.FormatUint(record.Seq, 10),
				Series:      sample.Series,
				ElapsedMs:   sample.ElapsedMs,
				UTCMs:       utc,
				Values:      nullableValues(sample),
				Disposition: disposition,
			})
			lastSequence = record.Seq
		}

		return nil
	})
	if err != nil {
		return SessionPage{}, err
	}

	if seen == 0 {
		return SessionPage{}, ErrSessionNotFound
	}

	page := SessionPage{
		Samples:           samples,
		Truncated:         truncated,
		TruncationReasons: reasons,
		Storage:           status,
	}

	if truncated && lastSequence > 0 {
		next := encodeCursor(cursor{
			boot:                boot,
			inventoryGeneration: generation,
			nextSequence:        lastSequence,
			snapshotThrough:     durable,
		})
		page.NextCursor = &next
	}

	return page, nil
}

// summaries groups retained samples into per-boot sessions.
func (r *sessionReader) summaries(
	ctx context.Context,
	reader *journal.Reader,
) ([]SessionSummary, error) {
	type sessionState struct {
		boot      journal.BootID
		bootOrder uint64
		start     int64
		end       int64
		samples   int
		conflicts int
		anchored  int
		utcStart  *int64
		utcEnd    *int64
		hasBoot   bool
	}

	anchors := map[journal.BootID]journal.Anchor{}
	slots := map[uint64]bool{}
	byBoot := map[journal.BootID]*sessionState{}
	order := make([]journal.BootID, 0)

	ensure := func(boot journal.BootID) *sessionState {
		state, ok := byBoot[boot]

		if ok {
			return state
		}

		state = &sessionState{boot: boot}
		byBoot[boot] = state
		order = append(order, boot)

		return state
	}

	err := reader.Scan(ctx, func(record journal.Record) error {
		switch record.Kind {
		case journal.KindBootStart:
			bootStart, err := journal.DecodeBootStart(record)
			if err != nil {
				return nil
			}

			state := ensure(bootStart.Boot)
			state.bootOrder = record.Seq
			state.hasBoot = true
		case journal.KindAnchor:
			if anchor, err := journal.DecodeAnchor(record); err == nil {
				if existing, ok := anchors[anchor.Boot]; !ok || anchor.Seq >= existing.Seq {
					anchors[anchor.Boot] = anchor
				}
			}
		case journal.KindSample:
			sample, err := journal.DecodeSample(record)
			if err != nil {
				return nil
			}

			state := ensure(sample.Boot)
			state.samples++

			if state.start == 0 || sample.ElapsedMs < state.start {
				state.start = sample.ElapsedMs
			}

			if sample.ElapsedMs > state.end {
				state.end = sample.ElapsedMs
			}

			key := uint64(sample.Series)*1<<40 + uint64(alignSampleSlot(sample, anchors))

			if slots[key] {
				state.conflicts++
			}

			slots[key] = true

			if utc := mappedOrNil(sample, anchors); utc != nil {
				state.anchored++

				if state.utcStart == nil || *utc < *state.utcStart {
					value := *utc
					state.utcStart = &value
				}

				if state.utcEnd == nil || *utc > *state.utcEnd {
					value := *utc
					state.utcEnd = &value
				}
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	summaries := make([]SessionSummary, 0, len(order))

	for _, boot := range order {
		state := byBoot[boot]

		if !state.hasBoot {
			// A session without a boot-start record cannot be ordered; report it
			// by its boot identity instead of dropping it silently.
			state.bootOrder = 0
		}

		sessionState := "unanchored"

		if state.anchored > 0 && state.anchored == state.samples {
			sessionState = "anchored"
		} else if state.anchored > 0 {
			sessionState = "mixed"
		}

		summaries = append(summaries, SessionSummary{
			ID:             SessionID(boot),
			BootOrder:      strconv.FormatUint(state.bootOrder, 10),
			ElapsedStartMs: state.start,
			ElapsedEndMs:   state.end,
			SampleCount:    state.samples,
			ConflictCount:  state.conflicts,
			State:          sessionState,
			UTCStartMs:     state.utcStart,
			UTCEndMs:       state.utcEnd,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		left, _ := strconv.ParseUint(summaries[i].BootOrder, 10, 64)
		right, _ := strconv.ParseUint(summaries[j].BootOrder, 10, 64)

		return left > right
	})

	return summaries, nil
}

// storageStatus projects provider and pipeline state for diagnostics.
func (r *sessionReader) storageStatus(recovery journal.RecoveryStatus) StorageStatus {
	status := StorageStatus{
		Mode:              string(recovery.Mode),
		Issues:            []RecoveryIssueDTO{},
		Coverage:          []CoverageDTO{},
		DroppedRecords:    map[string]string{},
		JournalLimitBytes: r.limits.Bytes,
	}

	for _, issue := range recovery.Issues {
		dto := RecoveryIssueDTO{Code: issue.Code}

		if issue.FirstSequence != nil {
			value := strconv.FormatUint(*issue.FirstSequence, 10)
			dto.FirstSequence = &value
		}

		if issue.LastSequence != nil {
			value := strconv.FormatUint(*issue.LastSequence, 10)
			dto.LastSequence = &value
		}

		status.Issues = append(status.Issues, dto)
	}

	pipeline := r.status()
	pending := pipeline.PendingSamples
	status.PendingSampleCount = &pending

	if pipeline.Error != "" {
		message := pipeline.Error
		status.DeliveryError = &message
	}

	for reason, count := range pipeline.Loss {
		status.DroppedRecords[reason] = strconv.FormatUint(count, 10)
	}

	for _, coverage := range pipeline.Coverage {
		dto := CoverageDTO{
			Series:       coverage.Series,
			StartMs:      coverage.StartMs,
			EndMs:        coverage.EndMs,
			EdgeComplete: coverage.EdgeComplete,
			Complete:     coverage.Complete,
			Reasons:      []string{},
		}

		for _, reason := range coverage.Reasons {
			dto.Reasons = append(dto.Reasons, string(reason))
		}

		status.Coverage = append(status.Coverage, dto)
	}

	return status
}

func alignSampleSlot(sample journal.Sample, anchors map[journal.BootID]journal.Anchor) int64 {
	anchor, ok := anchors[sample.Boot]

	if !ok {
		return sample.ElapsedMs
	}

	mapped, err := clock.MapUTC(anchor, sample.ElapsedMs)
	if err != nil {
		return sample.ElapsedMs
	}

	return clock.AlignSlot(mapped, journal.StepForSeries(sample.Series))
}

func mappedOrNil(sample journal.Sample, anchors map[journal.BootID]journal.Anchor) *int64 {
	anchor, ok := anchors[sample.Boot]

	if !ok {
		return nil
	}

	mapped, err := clock.MapUTC(anchor, sample.ElapsedMs)
	if err != nil {
		return nil
	}

	return &mapped
}

func nullableValues(sample journal.Sample) []*float64 {
	values := make([]*float64, 0, len(sample.Values))

	for _, value := range sample.Values {
		if !value.Known {
			values = append(values, nil)

			continue
		}

		known := value.V
		values = append(values, &known)
	}

	return values
}

func durableThrough(lease readLease) uint64 {
	if lease.progress == nil {
		return 0
	}

	return lease.progress.DurableThrough()
}

func generationOf(lease readLease) uint64 {
	if lease.progress == nil {
		return 0
	}

	return lease.progress.Manifest().Generation
}
