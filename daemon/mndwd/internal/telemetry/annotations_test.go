package telemetry

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/events"
)

type annotationTestCatalog struct{}

func (annotationTestCatalog) Collections() []AnnotationCollection {
	return []AnnotationCollection{{Name: "load", Retention: time.Hour}, {Name: "temp", Retention: 2 * time.Hour}}
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

func TestAnnotationStoreLoadsPrunesAndFlushesAtomically(t *testing.T) {
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

	store, err := NewAnnotationStore(AnnotationStoreConfig{RRDDir: directory, Catalog: annotationTestCatalog{}, Now: func() time.Time { return now }})
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

func TestAnnotationStoreRunsIndependentlyOfTelemetrySampling(t *testing.T) {
	store, err := NewAnnotationStore(AnnotationStoreConfig{RRDDir: t.TempDir(), Catalog: annotationTestCatalog{}})
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
