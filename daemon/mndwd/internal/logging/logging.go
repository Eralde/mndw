// Package logging contains the daemon's bounded file output and repeat-collapsing slog handler.
package logging

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"
)

const DefaultLogFileLimit int64 = 512 * 1024

var ErrRecordTooLarge = errors.New("log record exceeds file size limit")

// RotatingFile keeps one active log and one backup, each capped at limit bytes.
type RotatingFile struct {
	path   string
	limit  int64
	mu     sync.Mutex
	file   *os.File
	size   int64
	closed bool
}

// OpenRotatingFile returns a writer that retries opening path on every write
// after an initial failure. Oversized logs retain only complete tail lines.
func OpenRotatingFile(path string, limit int64) (*RotatingFile, error) {
	if limit <= 0 {
		limit = DefaultLogFileLimit
	}

	file := &RotatingFile{path: path, limit: limit}

	file.mu.Lock()

	err := file.openLocked()

	file.mu.Unlock()

	if err != nil {
		return file, err
	}

	return file, nil
}

func (f *RotatingFile) Write(data []byte) (int, error) {
	if int64(len(data)) > f.limit {
		return 0, ErrRecordTooLarge
	}

	f.mu.Lock()

	defer f.mu.Unlock()

	if f.closed {
		return 0, os.ErrClosed
	}

	if err := f.ensureOpenLocked(); err != nil {
		return 0, err
	}

	if f.size+int64(len(data)) > f.limit {
		if err := f.rotateLocked(); err != nil {
			return 0, err
		}

		if err := f.ensureOpenLocked(); err != nil {
			return 0, err
		}
	}

	n, err := f.file.Write(data)
	f.size += int64(n)

	return n, err
}

// Close closes the active file.
func (f *RotatingFile) Close() error {
	f.mu.Lock()

	defer f.mu.Unlock()

	if f.closed {
		return nil
	}

	f.closed = true

	if f.file == nil {
		return nil
	}

	err := f.file.Close()
	f.file = nil

	return err
}

func (f *RotatingFile) boundExistingLog() error {
	info, err := os.Stat(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil {
		return fmt.Errorf("stat log file: %w", err)
	}

	if info.Size() <= f.limit {
		f.size = info.Size()

		return nil
	}

	input, err := os.Open(f.path)
	if err != nil {
		return fmt.Errorf("open oversized log file: %w", err)
	}

	defer input.Close()

	tail := make([]byte, f.limit)
	read, err := input.ReadAt(tail, info.Size()-f.limit)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("read oversized log tail: %w", err)
	}

	tail = tail[:read]

	var previous [1]byte

	if _, err := input.ReadAt(previous[:], info.Size()-f.limit-1); err != nil {
		return fmt.Errorf("read oversized log boundary: %w", err)
	}

	if previous[0] != '\n' {
		if lineEnd := bytes.IndexByte(tail, '\n'); lineEnd >= 0 {
			tail = tail[lineEnd+1:]
		} else {
			tail = nil
		}
	}

	if err := os.WriteFile(f.path, tail, 0o600); err != nil {
		return fmt.Errorf("bound oversized log file: %w", err)
	}

	f.size = int64(len(tail))

	return nil
}

func (f *RotatingFile) ensureOpenLocked() error {
	if f.file != nil {
		return nil
	}

	return f.openLocked()
}

func (f *RotatingFile) openLocked() error {
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return fmt.Errorf("create log directory: %w", err)
	}

	if err := f.boundExistingLog(); err != nil {
		return err
	}

	file, err := os.OpenFile(f.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}

	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()

		return fmt.Errorf("protect log file: %w", err)
	}

	info, err := file.Stat()
	if err != nil {
		_ = file.Close()

		return fmt.Errorf("stat open log file: %w", err)
	}

	f.file = file
	f.size = info.Size()

	return nil
}

func (f *RotatingFile) rotateLocked() error {
	if f.file != nil {
		err := f.file.Close()
		f.file = nil

		if err != nil {
			return fmt.Errorf("close log file before rotation: %w", err)
		}
	}

	if err := os.Remove(f.path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove old log backup: %w", err)
	}

	if _, err := os.Stat(f.path); err == nil {
		if err := os.Rename(f.path, f.path+".1"); err != nil {
			return fmt.Errorf("rotate log file: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat log file before rotation: %w", err)
	}

	f.size = 0

	return nil
}

type RepeatHandlerConfig struct {
	Now           func() time.Time
	FlushInterval time.Duration
	Ticker        <-chan time.Time
	StopTicker    func()
	DisableTicker bool
}

type repeatAttribute struct {
	groups []string
	attr   slog.Attr
}

type repeatState struct {
	mu          sync.Mutex
	key         []repeatAttribute
	message     string
	level       slog.Level
	repeats     uint64
	lastFlush   time.Time
	lastHandler slog.Handler
	closed      bool
	now         func() time.Time
	interval    time.Duration
	stop        chan struct{}
	done        chan struct{}
	stopTicker  func()
	closeOnce   sync.Once
}

// RepeatHandler writes each first record, suppresses consecutive equal records, and summarizes repeats.
type RepeatHandler struct {
	next   slog.Handler
	state  *repeatState
	attrs  []repeatAttribute
	groups []string
}

func NewRepeatHandler(next slog.Handler, config RepeatHandlerConfig) *RepeatHandler {
	if config.Now == nil {
		config.Now = time.Now
	}

	if config.FlushInterval <= 0 {
		config.FlushInterval = time.Hour
	}

	state := &repeatState{
		now:        config.Now,
		interval:   config.FlushInterval,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		stopTicker: config.StopTicker,
	}
	handler := &RepeatHandler{next: next, state: state}

	ticker := config.Ticker

	if ticker == nil && !config.DisableTicker {
		created := time.NewTicker(config.FlushInterval)
		ticker = created.C
		state.stopTicker = created.Stop
	}

	if ticker == nil {
		close(state.done)
	} else {
		go handler.flushLoop(ticker)
	}

	return handler
}

func (h *RepeatHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *RepeatHandler) Handle(ctx context.Context, record slog.Record) error {
	attrs := append([]repeatAttribute(nil), h.attrs...)

	record.Attrs(func(attr slog.Attr) bool {
		attrs = append(attrs, flattenAttribute(attr, h.groups)...)

		return true
	})

	h.state.mu.Lock()

	defer h.state.mu.Unlock()

	if h.state.closed {
		return os.ErrClosed
	}

	now := h.state.now()

	if sameRecord(h.state, record, attrs) {
		h.state.repeats++

		if now.Sub(h.state.lastFlush) >= h.state.interval {
			return h.state.flushSummary(ctx, now)
		}

		return nil
	}

	if h.state.repeats > 0 {
		if err := h.state.flushSummary(ctx, now); err != nil {
			return err
		}
	}

	h.state.key = attrs
	h.state.message = record.Message
	h.state.level = record.Level
	h.state.lastFlush = now
	h.state.lastHandler = h.next

	return h.next.Handle(ctx, record)
}

func (h *RepeatHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	copyAttrs := append([]repeatAttribute(nil), h.attrs...)

	for _, attr := range attrs {
		copyAttrs = append(copyAttrs, flattenAttribute(attr, h.groups)...)
	}

	return &RepeatHandler{
		next:   h.next.WithAttrs(attrs),
		state:  h.state,
		attrs:  copyAttrs,
		groups: append([]string(nil), h.groups...),
	}
}

func (h *RepeatHandler) WithGroup(name string) slog.Handler {
	groups := append([]string(nil), h.groups...)

	if name != "" {
		groups = append(groups, name)
	}

	return &RepeatHandler{
		next:   h.next.WithGroup(name),
		state:  h.state,
		attrs:  append([]repeatAttribute(nil), h.attrs...),
		groups: groups,
	}
}

// Close stops periodic flushing and writes the remaining repeat count.
func (h *RepeatHandler) Close() error {
	var result error

	h.state.closeOnce.Do(func() {
		if h.state.stopTicker != nil {
			h.state.stopTicker()
		}

		close(h.state.stop)
		<-h.state.done

		h.state.mu.Lock()

		defer h.state.mu.Unlock()

		result = h.state.flushSummary(context.Background(), h.state.now())
		h.state.closed = true
	})

	return result
}

func (h *RepeatHandler) flushExpired() error {
	h.state.mu.Lock()

	defer h.state.mu.Unlock()

	if h.state.closed || h.state.repeats == 0 {
		return nil
	}

	now := h.state.now()

	if now.Sub(h.state.lastFlush) < h.state.interval {
		return nil
	}

	return h.state.flushSummary(context.Background(), now)
}

func (h *RepeatHandler) flushLoop(ticker <-chan time.Time) {
	defer close(h.state.done)

	for {
		select {
		case <-h.state.stop:
			return
		case _, ok := <-ticker:
			if !ok {
				return
			}

			_ = h.flushExpired()
		}
	}
}

func (s *repeatState) flushSummary(ctx context.Context, now time.Time) error {
	if s.repeats == 0 {
		return nil
	}

	record := slog.NewRecord(now, s.level, fmt.Sprintf("last message repeated %d times", s.repeats), 0)

	if err := s.lastHandler.Handle(ctx, record); err != nil {
		return err
	}

	s.repeats = 0
	s.lastFlush = now

	return nil
}

func sameRecord(state *repeatState, record slog.Record, attrs []repeatAttribute) bool {
	return state.lastHandler != nil && state.level == record.Level && state.message == record.Message && reflect.DeepEqual(state.key, attrs)
}

func flattenAttribute(attr slog.Attr, groups []string) []repeatAttribute {
	attr.Value = attr.Value.Resolve()

	if attr.Value.Kind() != slog.KindGroup {
		return []repeatAttribute{{groups: append([]string(nil), groups...), attr: attr}}
	}

	if attr.Key != "" {
		groups = append(append([]string(nil), groups...), attr.Key)
	}

	var flattened []repeatAttribute

	for _, child := range attr.Value.Group() {
		flattened = append(flattened, flattenAttribute(child, groups)...)
	}

	return flattened
}
