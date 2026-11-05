package system

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"path/filepath"
	"strings"
	"time"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/timekeeper"
)

const defaultDelay = 10 * time.Second
const defaultSyncEvery = 3 * time.Minute

// Clock pairs the operating-system boot clock with the wall clock.
type Clock interface {
	Read() (timekeeper.Reading, error)
	BootID() [16]byte
}

// NTPSource retrieves the raw show.ntp.status response.
type NTPSource func(ctx context.Context) ([]byte, error)

// Collector returns cpu, ram, and temperature samples; unknown values are NaN.
type Collector func(ctx context.Context) []float32

// View is the immutable telemetry state published after an engine event.
type View struct {
	NowMs         int64
	Anchored      bool
	ReplayPending bool
	Window        func(startSlot int64, count int) [][]float32
}

// Publisher receives the latest engine view.
type Publisher func(View)

// Config supplies engine storage, clock, collection, NTP, and publication dependencies.
type Config struct {
	Dir       string
	FS        ring.FS
	Clock     Clock
	NTP       NTPSource
	Collect   Collector
	Publish   Publisher
	Keeper    timekeeper.Config
	Delay     time.Duration
	SyncEvery time.Duration
	Logger    *slog.Logger
}

// EventKind identifies work scheduled by an engine.
type EventKind int

const (
	// EventTick writes one telemetry sample.
	EventTick EventKind = iota
	// EventClockCheck observes the wall-to-boot clock delta.
	EventClockCheck
	// EventSync flushes unsynced ring rows.
	EventSync
)

// Engine serializes telemetry collection, time acceptance, and ring writes.
type Engine struct {
	cfg                     Config
	bootID                  [16]byte
	keeper                  *timekeeper.Keeper
	history                 *ring.Ring
	currentPending          *ring.Ring
	currentPendingPathKnown bool
	storageDown             bool
	started                 bool
	stopped                 bool
	blockedTransfer         bool
	replayPending           bool
	reading                 timekeeper.Reading
	nextTickBootMs          int64
	nextClockCheckBootMs    int64
	syncDueBootMs           int64
	historyDirty            bool
	pendingDirty            bool
	pendingOverflowLogged   bool
	ntpErrorStreak          bool
	lastNTPDecline          string
}

// NewEngine constructs an engine without touching storage.
func NewEngine(cfg Config) *Engine {
	if cfg.FS == nil {
		cfg.FS = ring.OSFS{}
	}

	if cfg.Delay <= 0 {
		cfg.Delay = defaultDelay
	}

	if cfg.SyncEvery <= 0 {
		cfg.SyncEvery = defaultSyncEvery
	}

	if cfg.Keeper.MinValidUTC.IsZero() || cfg.Keeper.MaxValidUTC.IsZero() {
		cfg.Keeper = timekeeper.DefaultConfig()
	}

	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(ioDiscard{}, nil))
	}

	return &Engine{cfg: cfg}
}

// Start reads durable state, completes interrupted transfers, and publishes the initial view.
func (e *Engine) Start(ctx context.Context) error {
	if e.started {
		return nil
	}

	if e.cfg.Clock == nil {
		return errors.New("telemetry system: clock is required")
	}

	reading, err := e.cfg.Clock.Read()
	if err != nil {
		return fmt.Errorf("telemetry system: read boot clock: %w", err)
	}

	e.bootID = e.cfg.Clock.BootID()
	e.reading = reading
	e.started = true

	if err := e.openAndStartup(); err != nil {
		e.markStorageDown()
		e.setNextTick(reading.BootMs)

		e.nextClockCheckBootMs = reading.BootMs + e.cfg.Keeper.ClockCheckEvery.Milliseconds()

		e.publish()

		return nil
	}

	e.nextClockCheckBootMs = reading.BootMs + e.cfg.Keeper.ClockCheckEvery.Milliseconds()

	if !e.anchored() && !e.storageDown {
		if err := e.poll(ctx); err != nil {
			if errors.Is(err, ring.ErrIO) {
				e.markStorageDown()
			} else {
				return err
			}
		}
	}

	e.setNextTick(reading.BootMs)
	e.publish()

	return nil
}

// Next returns the next collection tick and its boot-clock deadline.
func (e *Engine) Next() (EventKind, int64) {
	if e.storageDown {
		return EventTick, e.nextTickBootMs
	}

	kind, due := EventClockCheck, e.nextClockCheckBootMs

	if e.nextTickBootMs <= due {
		kind, due = EventTick, e.nextTickBootMs
	}

	if e.syncDueBootMs > 0 && (e.syncDueBootMs < due || (e.syncDueBootMs == due && kind == EventSync)) {
		kind, due = EventSync, e.syncDueBootMs
	}

	if e.reading.BootMs >= e.nextTickBootMs {
		return EventTick, e.nextTickBootMs
	}

	if e.syncDueBootMs > 0 && e.reading.BootMs >= e.syncDueBootMs && e.reading.BootMs < e.nextTickBootMs {
		return EventSync, e.syncDueBootMs
	}

	if e.reading.BootMs >= e.nextClockCheckBootMs && e.reading.BootMs < e.nextTickBootMs {
		return EventClockCheck, e.nextClockCheckBootMs
	}

	return kind, due
}

// Handle executes one scheduled engine event.
func (e *Engine) Handle(ctx context.Context, kind EventKind) error {
	if !e.started || e.stopped {
		return errors.New("telemetry system: engine is not running")
	}

	reading, err := e.cfg.Clock.Read()
	if err != nil {
		return fmt.Errorf("telemetry system: read boot clock: %w", err)
	}

	e.reading = reading

	if e.storageDown {
		if kind != EventTick {
			e.publish()

			return nil
		}

		if err := e.reopen(); err != nil {
			e.markStorageDown()
			e.setNextTick(reading.BootMs)
			e.publish()

			return nil
		}

		if !e.anchored() {
			if err := e.poll(ctx); err != nil {
				if errors.Is(err, ring.ErrIO) {
					e.markStorageDown()
				} else {
					return err
				}
			}
		}

		e.setNextTick(reading.BootMs)

		e.nextClockCheckBootMs = nextDeadline(e.nextClockCheckBootMs, e.cfg.Keeper.ClockCheckEvery.Milliseconds(), reading.BootMs)

		e.publish()

		return nil
	}

	switch kind {
	case EventClockCheck:
		e.nextClockCheckBootMs = nextDeadline(e.nextClockCheckBootMs, e.cfg.Keeper.ClockCheckEvery.Milliseconds(), reading.BootMs)

		e.keeper.ObserveClock(reading)

		if e.keeper.WantPoll(reading, timekeeper.TriggerClockCheck) {
			if err := e.poll(ctx); err != nil {
				if errors.Is(err, ring.ErrIO) {
					e.markStorageDown()
				} else {
					return err
				}
			}
		}

		e.publish()

		return nil
	case EventSync:
		if e.syncDueBootMs == 0 || reading.BootMs < e.syncDueBootMs {
			return nil
		}

		if err := e.syncDirty(); err != nil {
			e.markStorageDown()
		}

		e.publish()

		return nil
	case EventTick:
	default:
		return fmt.Errorf("telemetry system: unknown event kind %d", kind)
	}

	values := []float32{float32(math.NaN()), float32(math.NaN()), float32(math.NaN())}

	if e.cfg.Collect != nil {
		values = e.cfg.Collect(ctx)
	}

	if len(values) != 3 {
		return fmt.Errorf("telemetry system: collector returned %d values, want 3", len(values))
	}

	for index, value := range values {
		if math.IsInf(float64(value), 0) {
			values[index] = float32(math.NaN())
		}
	}

	if state, anchored := e.keeper.Anchored(); anchored {
		slot := (reading.BootMs+state.OffsetMs-e.cfg.Delay.Milliseconds())/int64(ring.SystemSchema(ring.KindHistory).StepMs) - 1

		if slot >= 0 {
			if err := e.history.Write(slot, values); err != nil {
				e.markStorageDown()
				e.setNextTick(reading.BootMs)
				e.publish()

				return nil
			}

			e.markDirty(true, reading.BootMs)
		}
	} else {
		if err := e.writePending(reading.BootMs, values); err != nil {
			e.markStorageDown()
			e.setNextTick(reading.BootMs)
			e.publish()

			return nil
		}
	}

	if e.keeper.WantPoll(reading, timekeeper.TriggerTick) {
		if err := e.poll(ctx); err != nil {
			if errors.Is(err, ring.ErrIO) {
				e.markStorageDown()
			} else {
				return err
			}
		}
	}

	e.setNextTick(reading.BootMs)
	e.publish()

	return nil
}

// Stop flushes and closes storage; repeated calls are harmless.
func (e *Engine) Stop(context.Context) error {
	if e.stopped {
		return nil
	}

	e.stopped = true
	var firstErr error

	if !e.storageDown && e.currentPending != nil {
		if err := e.currentPending.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if !e.storageDown && e.history != nil {
		if err := e.history.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if e.currentPending != nil {
		if err := e.currentPending.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if e.history != nil {
		if err := e.history.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	return firstErr
}

func (e *Engine) openAndStartup() error {
	if err := e.cfg.FS.MkdirAll(e.cfg.Dir, 0o755); err != nil {
		return fmt.Errorf("%w: mkdir ring directory: %w", ring.ErrIO, err)
	}

	pendingDir := filepath.Join(e.cfg.Dir, "pending")

	if err := e.cfg.FS.MkdirAll(pendingDir, 0o755); err != nil {
		return fmt.Errorf("%w: mkdir pending directory: %w", ring.ErrIO, err)
	}

	history, err := ring.Open(e.cfg.FS, filepath.Join(e.cfg.Dir, "system.ring"), ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		return err
	}

	e.history = history
	e.storageDown = false
	e.currentPending = nil
	e.currentPendingPathKnown = false
	e.replayPending = false
	e.blockedTransfer = false
	e.historyDirty = false
	e.pendingDirty = false
	e.syncDueBootMs = 0

	return e.startupProcedure()
}

func (e *Engine) startupProcedure() error {
	state, err := readClockState(e.cfg.FS, filepath.Join(e.cfg.Dir, "clock.state"))
	if err != nil {
		return err
	}

	e.keeper = timekeeper.New(e.cfg.Keeper, e.bootID, state)
	pendingDir := filepath.Join(e.cfg.Dir, "pending")
	entries, err := e.cfg.FS.ReadDir(pendingDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			entries = nil
		} else {
			return fmt.Errorf("%w: read pending directory: %w", ring.ErrIO, err)
		}
	}

	var currentPendingPath string

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		pendingBootID, ok := parsePendingName(entry.Name())

		if !ok {
			continue
		}

		path := filepath.Join(pendingDir, entry.Name())

		if pendingBootID == e.bootID {
			currentPendingPath = path

			continue
		}

		if state != nil && pendingBootID == state.BootID {
			e.blockedTransfer = true

			e.keeper.SetBlocked(true)

			if err := e.transferPending(path, state.OffsetMs, false); err != nil {
				return err
			}

			e.blockedTransfer = false

			e.keeper.SetBlocked(false)

			continue
		}

		if err := e.removePending(path); err != nil {
			return err
		}
	}

	if state != nil && state.BootID == e.bootID {
		if currentPendingPath != "" {
			e.currentPendingPathKnown = true

			if err := e.transferPending(currentPendingPath, state.OffsetMs, true); err != nil {
				return err
			}
		}
	} else if currentPendingPath != "" {
		e.currentPendingPathKnown = true
	}

	if e.blockedTransfer {
		e.keeper.SetBlocked(true)
	}

	e.setNextTick(e.reading.BootMs)

	return nil
}

func (e *Engine) reopen() error {
	if e.history != nil {
		_ = e.history.Close()
	}

	if e.currentPending != nil {
		_ = e.currentPending.Close()
	}

	return e.openAndStartup()
}

func (e *Engine) writePending(bootMs int64, values []float32) error {
	if e.currentPending == nil {
		path := e.currentPendingPath()
		pending, err := ring.Open(e.cfg.FS, path, ring.SystemSchema(ring.KindPending), true)
		if err != nil {
			return err
		}

		e.currentPending = pending
		e.currentPendingPathKnown = true
	}

	slot := (bootMs-e.cfg.Delay.Milliseconds())/int64(ring.SystemSchema(ring.KindPending).StepMs) - 1

	if slot < 0 {
		return nil
	}

	if err := e.currentPending.Write(slot, values); err != nil {
		return err
	}

	if slot >= int64(ring.SystemSchema(ring.KindPending).Capacity) && !e.pendingOverflowLogged {
		e.cfg.Logger.Warn("pending ring capacity exceeded; oldest rows are being overwritten")

		e.pendingOverflowLogged = true
	}

	e.markDirty(false, bootMs)

	return nil
}

func (e *Engine) poll(ctx context.Context) error {
	if e.cfg.NTP == nil || e.storageDown || e.keeper == nil {
		return nil
	}

	before, err := e.cfg.Clock.Read()
	if err != nil {
		return err
	}

	body, sourceErr := e.cfg.NTP(ctx)
	after, err := e.cfg.Clock.Read()
	if err != nil {
		return err
	}

	if sourceErr != nil {
		e.keeper.PollFailed(after)
		e.logNTPFailure(sourceErr)

		return nil
	}

	status, err := timekeeper.DecodeNTPStatus(body)
	if err != nil {
		e.keeper.PollFailed(after)
		e.logNTPFailure(err)

		return nil
	}

	e.ntpErrorStreak = false
	outcome := e.keeper.Evaluate(before, after, status)

	if outcome.Decision != timekeeper.Accept {
		e.logNTPDecline(outcome.Reason, status)

		return nil
	}

	if err := writeClockState(e.cfg.FS, e.cfg.Dir, outcome.State); err != nil {
		return err
	}

	e.keeper.Commit(outcome.State)

	e.lastNTPDecline = ""

	e.cfg.Logger.Info("NTP evidence accepted", "server", outcome.State.Server, "offsetMs", outcome.State.OffsetMs)

	if err := e.transferPending(e.currentPendingPath(), outcome.State.OffsetMs, true); err != nil {
		return err
	}

	e.blockedTransfer = false

	e.setNextTick(after.BootMs)

	return nil
}

func (e *Engine) anchored() bool {
	if e.keeper == nil {
		return false
	}

	_, ok := e.keeper.Anchored()

	return ok
}

func (e *Engine) markStorageDown() {
	e.storageDown = true

	if e.currentPending != nil {
		_ = e.currentPending.Close()
	}

	if e.history != nil {
		_ = e.history.Close()
	}
}

func (e *Engine) markDirty(history bool, bootMs int64) {
	wasDirty := e.historyDirty || e.pendingDirty

	if history {
		e.historyDirty = true
	} else {
		e.pendingDirty = true
	}

	if !wasDirty {
		e.syncDueBootMs = bootMs + e.cfg.SyncEvery.Milliseconds()
	}
}

func (e *Engine) syncDirty() error {
	if e.historyDirty && e.history != nil {
		if err := e.history.Sync(); err != nil {
			return err
		}
	}

	if e.pendingDirty && e.currentPending != nil {
		if err := e.currentPending.Sync(); err != nil {
			return err
		}
	}

	e.historyDirty = false
	e.pendingDirty = false
	e.syncDueBootMs = 0

	return nil
}

func (e *Engine) logNTPFailure(err error) {
	if e.ntpErrorStreak {
		return
	}

	e.cfg.Logger.Warn("NTP poll failed", "error", err)

	e.ntpErrorStreak = true
}

func (e *Engine) logNTPDecline(reason string, status timekeeper.NTPStatus) {
	if reason == e.lastNTPDecline {
		return
	}

	e.cfg.Logger.Info(
		"NTP evidence not accepted",
		"reason", reason,
		"server", status.Server,
		"accurate", status.Accurate,
		"usertime", status.UserTime,
		"ndsstime", status.NDSSTime,
	)

	e.lastNTPDecline = reason
}

func (e *Engine) setNextTick(bootMs int64) {
	step := int64(ring.SystemSchema(ring.KindHistory).StepMs)
	offset := int64(0)

	if e.keeper != nil {
		if state, anchored := e.keeper.Anchored(); anchored {
			offset = state.OffsetMs
		}
	}

	gridNow := bootMs + offset - e.cfg.Delay.Milliseconds()
	e.nextTickBootMs = (gridNow/step+1)*step + e.cfg.Delay.Milliseconds() - offset
}

func nextDeadline(previous, interval, now int64) int64 {
	if interval <= 0 {
		return now
	}

	if previous <= now {
		missed := (now-previous)/interval + 1

		return previous + missed*interval
	}

	return previous
}

func (e *Engine) publish() {
	if e.cfg.Publish == nil {
		return
	}

	nowMs := e.reading.WallMs

	if e.keeper != nil {
		if state, anchored := e.keeper.Anchored(); anchored {
			nowMs = e.reading.BootMs + state.OffsetMs
		}
	}

	anchored := false

	if e.keeper != nil {
		_, anchored = e.keeper.Anchored()
	}

	view := View{
		NowMs:         nowMs,
		Anchored:      anchored,
		ReplayPending: e.replayPending,
	}
	history := e.history
	view.Window = func(startSlot int64, count int) [][]float32 {
		if history != nil {
			return history.Window(startSlot, count)
		}

		window := make([][]float32, count)

		for index := range window {
			window[index] = []float32{float32(math.NaN()), float32(math.NaN()), float32(math.NaN())}
		}

		return window
	}

	e.cfg.Publish(view)
}

func (e *Engine) currentPendingPath() string {
	return filepath.Join(e.cfg.Dir, "pending", hex.EncodeToString(e.bootID[:])+".ring")
}

func parsePendingName(name string) ([16]byte, bool) {
	var bootID [16]byte

	if !strings.HasSuffix(name, ".ring") || len(name) != 32+len(".ring") {
		return bootID, false
	}

	for _, character := range name[:32] {
		if character < '0' || (character > '9' && character < 'a') || character > 'f' {
			return bootID, false
		}
	}

	decoded, err := hex.DecodeString(name[:32])
	if err != nil {
		return bootID, false
	}

	copy(bootID[:], decoded)

	return bootID, true
}

type ioDiscard struct{}

func (ioDiscard) Write(data []byte) (int, error) {
	return len(data), nil
}
