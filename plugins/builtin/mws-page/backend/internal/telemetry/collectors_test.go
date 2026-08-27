package telemetry

import (
	"testing"
	"time"
)

func TestCollectorStoresPersistentTelemetryByIdentity(t *testing.T) {
	collector := NewCollector()
	when := time.Unix(100, 0).UTC()
	sample := PersistentTelemetry{SampledAt: when, System: System{CPULoad: 27}}

	collector.StorePersistent("cid-1", sample)

	got, ok := collector.Persistent("cid-1", when.Add(time.Minute))

	if !ok {
		t.Fatal("persistent telemetry missing")
	}

	if got.System.CPULoad != 27 || !got.SampledAt.Equal(when) {
		t.Fatalf("persistent telemetry = %#v", got)
	}
}

func TestCollectorDropsStalePersistentTelemetry(t *testing.T) {
	collector := NewCollector()
	when := time.Unix(100, 0).UTC()

	collector.StorePersistent("cid-1", PersistentTelemetry{SampledAt: when})

	if _, ok := collector.Persistent("cid-1", when.Add(4*time.Minute)); ok {
		t.Fatal("stale persistent telemetry returned")
	}
}
