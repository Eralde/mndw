package annotations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/events"
)

type annotationTestCatalog struct{}

func (annotationTestCatalog) Collections() []Collection {
	return []Collection{{Name: "load", Retention: time.Hour}, {Name: "temp", Retention: 2 * time.Hour}}
}

func (annotationTestCatalog) LabelFor(topic string) (string, string, bool) {
	if topic == string(contractEvents.TopicWanConnected) {
		return "load", "WAN connected", true
	}

	return "", "", false
}

func annotationEvent(id string, ts int64) events.Event {
	return events.Event{ID: id, Ts: ts, Topic: contractEvents.TopicWanConnected, Source: contractEvents.SourceHook, Payload: json.RawMessage(`{"interface":"ppp0","address":"192.0.2.1","mask":"255.255.255.0","gateway":"192.0.2.254"}`)}
}

func TestStoreLoadsPrunesAndFlushesAtomically(t *testing.T) {
	directory := t.TempDir()
	now := time.Unix(10_000, 0)
	initial := []Annotation{{ID: "old", Ts: now.Add(-3 * time.Hour).UnixMilli(), Topic: "wan.connected", Label: "old"}, {ID: "keep", Ts: now.Add(-30 * time.Minute).UnixMilli(), Topic: "wan.connected", Label: "keep"}}
	data, err := json.Marshal(initial)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(directory, "load.annotations.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	store, err := NewStore(Config{RRDDir: directory, Catalog: annotationTestCatalog{}, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}

	if got := len(store.Collections()["load"]); got != 1 {
		t.Fatalf("loaded annotations = %d, want 1", got)
	}

	store.Consume(annotationEvent("new", now.UnixMilli()))

	if err := store.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}

	flushed, err := os.ReadFile(filepath.Join(directory, "load.annotations.json"))
	if err != nil {
		t.Fatal(err)
	}

	var annotations []Annotation

	if err := json.Unmarshal(flushed, &annotations); err != nil {
		t.Fatal(err)
	}

	if len(annotations) != 2 {
		t.Fatalf("flushed annotations = %#v", annotations)
	}
}

func TestStoreRunsIndependentlyOfTelemetrySampling(t *testing.T) {
	store, err := NewStore(Config{RRDDir: t.TempDir(), Catalog: annotationTestCatalog{}})
	if err != nil {
		t.Fatal(err)
	}

	bus := events.NewBus()

	if err := store.Start(context.Background(), bus); err != nil {
		t.Fatal(err)
	}

	store.Consume(annotationEvent("event", time.Now().UnixMilli()))

	if err := store.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(store.Collections()["load"]) != 1 {
		t.Fatal("annotation subscriber did not consume event")
	}
}

// annotationTestFS records annotation writes and can fail them.
type annotationTestFS struct {
	mu         sync.Mutex
	writes     int
	failWrites bool
}

func newAnnotationTestFS(_ *testing.T, _ string) *annotationTestFS { return &annotationTestFS{} }

func (fs *annotationTestFS) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(name)
}

func (fs *annotationTestFS) WriteFile(name string, data []byte, perm os.FileMode) error {
	fs.mu.Lock()

	fs.writes++
	fail := fs.failWrites

	fs.mu.Unlock()

	if fail {
		return errors.New("injected write failure")
	}

	return os.WriteFile(name, data, perm)
}

func (fs *annotationTestFS) Rename(oldPath, newPath string) error { return os.Rename(oldPath, newPath) }

func (fs *annotationTestFS) MkdirAll(path string, perm os.FileMode) error {
	return os.MkdirAll(path, perm)
}

func TestAnnotationPruningSkippedWithoutTrustedClock(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStore(Config{
		RRDDir:     directory,
		Catalog:    annotationTestCatalog{},
		FileSystem: newAnnotationTestFS(t, directory),
		Now:        func() time.Time { return time.Unix(1_800_000_000, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}

	// Without a trusted clock the retention cutoff is never applied, so an old
	// annotation is retained rather than deleted on an untrusted clock.
	store.Consume(annotationEvent("old", 1_700_000_000_000))

	annotations := store.Collections()["load"]

	if len(annotations) != 1 || annotations[0].ID != "old" {
		t.Fatalf("annotations=%+v", annotations)
	}
}

func TestAnnotationRejectsUnprovenEventTimestamp(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStore(Config{
		RRDDir:     directory,
		Catalog:    annotationTestCatalog{},
		FileSystem: newAnnotationTestFS(t, directory),
		TrustedNow: func() (time.Time, bool) { return time.Unix(1_800_000_000, 0), true },
		AcceptTimestamp: func(event events.Event) bool {
			return event.ID == "proven"
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	store.Consume(annotationEvent("unproven", 1_800_000_000_000))
	store.Consume(annotationEvent("proven", 1_800_000_000_000))

	annotations := store.Collections()["load"]

	if len(annotations) != 1 || annotations[0].ID != "proven" {
		t.Fatalf("annotations=%+v", annotations)
	}
}

func TestAnnotationFlushRetriesWhileDirty(t *testing.T) {
	directory := t.TempDir()
	fs := newAnnotationTestFS(t, directory)
	fs.failWrites = true

	store, err := NewStore(Config{
		RRDDir:     directory,
		Catalog:    annotationTestCatalog{},
		FileSystem: fs,
		TrustedNow: func() (time.Time, bool) { return time.Unix(1_800_000_000, 0), true },
	})
	if err != nil {
		t.Fatal(err)
	}

	store.Consume(annotationEvent("evt", 1_800_000_000_000))

	if err := store.Flush(context.Background()); err == nil {
		t.Fatal("failed write accepted")
	}

	fs.mu.Lock()

	fs.failWrites = false

	fs.mu.Unlock()

	if err := store.Flush(context.Background()); err != nil {
		t.Fatalf("retry after failure: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(directory, "load.annotations.json"))
	if err != nil {
		t.Fatalf("annotations not persisted: %v", err)
	}

	if !bytes.Contains(data, []byte("evt")) {
		t.Fatalf("persisted=%s", data)
	}
}
