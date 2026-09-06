package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"mndwd/internal/events"
)

const AnnotationFlushInterval = 30 * time.Second

type Annotation struct {
	ID    string `json:"id"`
	Ts    int64  `json:"ts"`
	Topic string `json:"topic"`
	Label string `json:"label"`
}

type AnnotationCollection struct {
	Name      string
	Retention time.Duration
}

type AnnotationCatalog interface {
	Collections() []AnnotationCollection
	LabelFor(topic string) (collection string, label string, ok bool)
}

type annotationFileSystem interface {
	ReadFile(name string) ([]byte, error)
	WriteFile(name string, data []byte, perm os.FileMode) error
	Rename(oldPath, newPath string) error
	MkdirAll(path string, perm os.FileMode) error
}

type osAnnotationFileSystem struct{}

func (osAnnotationFileSystem) ReadFile(name string) ([]byte, error) { return os.ReadFile(name) }
func (osAnnotationFileSystem) WriteFile(name string, data []byte, perm os.FileMode) error {
	return os.WriteFile(name, data, perm)
}
func (osAnnotationFileSystem) Rename(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}
func (osAnnotationFileSystem) MkdirAll(path string, perm os.FileMode) error {
	return os.MkdirAll(path, perm)
}

type AnnotationStoreConfig struct {
	RRDDir     string
	Catalog    AnnotationCatalog
	Now        func() time.Time
	Interval   time.Duration
	FileSystem annotationFileSystem
	Logger     *slog.Logger
}

type AnnotationStore struct {
	rrdDir   string
	catalog  AnnotationCatalog
	now      func() time.Time
	interval time.Duration
	fs       annotationFileSystem
	logger   *slog.Logger

	mu          sync.Mutex
	annotations map[string][]Annotation
	cancel      context.CancelFunc
	subCancel   events.CancelFunc
	done        chan struct{}
	closed      bool
}

func NewAnnotationStore(config AnnotationStoreConfig) (*AnnotationStore, error) {
	if config.RRDDir == "" {
		return nil, errors.New("telemetry annotation RRD directory is required")
	}

	if config.Catalog == nil {
		return nil, errors.New("telemetry annotation catalog is required")
	}

	if config.Now == nil {
		config.Now = time.Now
	}

	if config.Interval <= 0 {
		config.Interval = AnnotationFlushInterval
	}

	if config.FileSystem == nil {
		config.FileSystem = osAnnotationFileSystem{}
	}

	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	store := &AnnotationStore{
		rrdDir:      config.RRDDir,
		catalog:     config.Catalog,
		now:         config.Now,
		interval:    config.Interval,
		fs:          config.FileSystem,
		logger:      config.Logger,
		annotations: make(map[string][]Annotation),
	}

	for _, collection := range config.Catalog.Collections() {
		store.annotations[collection.Name] = nil

		store.readCollection(collection)
	}

	store.pruneLocked(store.now())

	return store, nil
}

func (s *AnnotationStore) Start(parent context.Context, bus *events.Bus) error {
	if parent == nil {
		parent = context.Background()
	}

	if bus == nil {
		return errors.New("telemetry annotation bus is required")
	}

	s.mu.Lock()

	if s.closed {
		s.mu.Unlock()

		return errors.New("telemetry annotation store is closed")
	}

	if s.cancel != nil {
		s.mu.Unlock()

		return nil
	}

	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.done = make(chan struct{})

	s.mu.Unlock()

	// Subscribe returns an unexported channel type through the public bus API; consume it
	// in this goroutine so annotation storage remains decoupled from chart sampling.
	channel, subCancel, err := bus.Subscribe(allTopicsFilter())
	if err != nil {
		subCancel()
		cancel()
		s.mu.Lock()

		s.cancel = nil
		s.done = nil

		s.mu.Unlock()

		return err
	}

	s.mu.Lock()

	s.subCancel = subCancel
	done := s.done

	s.mu.Unlock()

	go func() {
		ticker := time.NewTicker(s.interval)

		defer ticker.Stop()

		defer close(done)

		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-channel:
				if !ok {
					return
				}

				s.Consume(event)
			case <-ticker.C:
				if err := s.Flush(context.Background()); err != nil {
					s.logger.Warn("telemetry annotation flush failed", "error", err)
				}
			}
		}
	}()

	return nil
}

func (s *AnnotationStore) Consume(event events.Event) {
	collection, label, ok := s.catalog.LabelFor(string(event.Topic))

	if !ok || label == "" {
		return
	}

	s.mu.Lock()

	defer s.mu.Unlock()

	if _, exists := s.annotations[collection]; !exists || event.Ts < s.cutoffLocked(s.now()) {
		return
	}

	s.annotations[collection] = append(s.annotations[collection], Annotation{
		ID:    event.ID,
		Ts:    event.Ts,
		Topic: string(event.Topic),
		Label: label,
	})
}

func (s *AnnotationStore) Flush(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()
	s.pruneLocked(s.now())

	collections := make(map[string][]Annotation, len(s.annotations))

	for name, annotations := range s.annotations {
		collections[name] = append([]Annotation(nil), annotations...)
	}

	s.mu.Unlock()

	if err := s.fs.MkdirAll(s.rrdDir, 0o755); err != nil {
		return err
	}

	for _, collection := range s.catalog.Collections() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		data, err := json.Marshal(collections[collection.Name])
		if err != nil {
			return fmt.Errorf("encode annotations for %s: %w", collection.Name, err)
		}

		path := filepath.Join(s.rrdDir, collection.Name+".annotations.json")
		temporary := path + ".tmp"

		if err := s.fs.WriteFile(temporary, append(data, '\n'), 0o644); err != nil {
			return fmt.Errorf("write annotations for %s: %w", collection.Name, err)
		}

		if err := s.fs.Rename(temporary, path); err != nil {
			return fmt.Errorf("replace annotations for %s: %w", collection.Name, err)
		}
	}

	return nil
}

func (s *AnnotationStore) Close(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()

	if s.closed {
		s.mu.Unlock()

		return nil
	}

	s.closed = true
	cancel := s.cancel
	subCancel := s.subCancel
	done := s.done

	s.mu.Unlock()

	if subCancel != nil {
		subCancel()
	}

	if cancel != nil {
		cancel()
	}

	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	return s.Flush(ctx)
}

func (s *AnnotationStore) Collections() map[string][]Annotation {
	s.mu.Lock()

	defer s.mu.Unlock()

	result := make(map[string][]Annotation, len(s.annotations))

	for name, annotations := range s.annotations {
		result[name] = append([]Annotation(nil), annotations...)
	}

	return result
}

func (s *AnnotationStore) readCollection(collection AnnotationCollection) {
	path := filepath.Join(s.rrdDir, collection.Name+".annotations.json")
	data, err := s.fs.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.logger.Warn("telemetry annotation sidecar unavailable", "collection", collection.Name, "error", err)
		}

		return
	}

	var annotations []Annotation

	if err := json.Unmarshal(data, &annotations); err != nil {
		s.logger.Warn("telemetry annotation sidecar is corrupt", "collection", collection.Name, "error", err)

		return
	}

	valid := annotations[:0]

	for _, annotation := range annotations {
		if annotation.ID == "" || annotation.Ts < 0 || annotation.Topic == "" || annotation.Label == "" {
			continue
		}

		valid = append(valid, annotation)
	}

	s.annotations[collection.Name] = append([]Annotation(nil), valid...)
}

func (s *AnnotationStore) cutoffLocked(now time.Time) int64 {
	retention := time.Duration(0)

	for _, collection := range s.catalog.Collections() {
		if collection.Retention > retention {
			retention = collection.Retention
		}
	}

	return now.Add(-retention).UnixMilli()
}

func (s *AnnotationStore) pruneLocked(now time.Time) {
	cutoff := s.cutoffLocked(now)

	for collection, annotations := range s.annotations {
		kept := annotations[:0]
		seen := make(map[string]struct{}, len(annotations))

		for _, annotation := range annotations {
			if annotation.Ts < cutoff {
				continue
			}

			if _, exists := seen[annotation.ID]; exists {
				continue
			}

			seen[annotation.ID] = struct{}{}
			kept = append(kept, annotation)
		}

		sort.SliceStable(kept, func(left, right int) bool { return kept[left].Ts < kept[right].Ts })

		s.annotations[collection] = kept
	}
}

func allTopicsFilter() events.TopicFilter {
	filter, _ := events.ParseTopicFilter([]string{"*"})

	return filter
}

type DefaultAnnotationCatalog struct{}

func (DefaultAnnotationCatalog) Collections() []AnnotationCollection {
	return []AnnotationCollection{
		{Name: "load", Retention: 30 * 24 * time.Hour},
		{Name: "temp", Retention: 30 * 24 * time.Hour},
	}
}

func (DefaultAnnotationCatalog) LabelFor(string) (string, string, bool) {
	return "", "", false
}
