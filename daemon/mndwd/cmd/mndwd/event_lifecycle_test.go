package main

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/events"
	"mndwd/internal/selfupdate"
)

type stubSelfUpdateStatus struct{}

func (stubSelfUpdateStatus) Status() (selfupdate.Status, error) { return selfupdate.Status{}, nil }

func newTestEventLifecycle(t *testing.T) (*eventLifecycle, *events.Bus) {
	t.Helper()

	bus := events.NewBus()
	normalizer := events.NewNormalizer(time.Now, nil)
	lifecycle := &eventLifecycle{
		bus:                bus,
		normalizer:         normalizer,
		internal:           events.NewInternalPublisher(bus, normalizer),
		ingest:             events.NewDeduplicatingPublisher(bus, events.NewDeduplicator(time.Now)),
		selfUpdate:         stubSelfUpdateStatus{},
		selfUpdateStateDir: t.TempDir(),
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		startedAt:          time.Now(),
	}

	t.Cleanup(lifecycle.Close)

	return lifecycle, bus
}

func daemonEvents(t *testing.T, bus *events.Bus, topic contractEvents.Topic) []events.Event {
	t.Helper()

	filter, err := events.ParseTopicFilter([]string{"daemon"})
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := bus.Snapshot("", filter)
	if err != nil {
		t.Fatal(err)
	}

	matched := make([]events.Event, 0, len(snapshot))

	for _, event := range snapshot {
		if event.Topic == topic {
			matched = append(matched, event)
		}
	}

	return matched
}

func TestEventLifecycleStartIsIdempotent(t *testing.T) {
	lifecycle, bus := newTestEventLifecycle(t)

	for range 2 {
		if err := lifecycle.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
	}

	if got := len(daemonEvents(t, bus, contractEvents.TopicDaemonStarted)); got != 1 {
		t.Fatalf("daemon.started published %d times, want 1", got)
	}
}

func TestEventLifecycleStopBeforeStartPublishesNothing(t *testing.T) {
	lifecycle, bus := newTestEventLifecycle(t)

	lifecycle.Stop("shutdown")

	if got := len(daemonEvents(t, bus, contractEvents.TopicDaemonStopping)); got != 0 {
		t.Fatalf("daemon.stopping published %d times before Start, want 0", got)
	}
}

func TestEventLifecycleStopAfterStartAnnouncesReason(t *testing.T) {
	lifecycle, bus := newTestEventLifecycle(t)

	if err := lifecycle.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	lifecycle.Stop("shutdown")

	stopping := daemonEvents(t, bus, contractEvents.TopicDaemonStopping)

	if len(stopping) != 1 || !strings.Contains(string(stopping[0].Payload), `"shutdown"`) {
		t.Fatalf("daemon.stopping events = %#v, want one with reason shutdown", stopping)
	}
}

func TestEventLifecycleCloseIsSafeWithoutStartAndTwice(t *testing.T) {
	lifecycle, _ := newTestEventLifecycle(t)

	lifecycle.Close()
	lifecycle.Close()
}
