package telemetry

import (
	"context"
	"testing"
	"time"

	"mws-page/internal/credentials"
)

func TestCollectorNullsOfflineAndStaleSamples(t *testing.T) {
	epoch := credentials.NewEpoch()
	epoch.Begin(context.Background())
	collector := NewCollector(nil, epoch, FieldAdapter{})
	collector.SetInterval(time.Minute)
	when := time.Unix(100, 0)
	if err := collector.Store("node", Vitals{CPU: 1, SampledAt: when}, epoch.Current()); err != nil {
		t.Fatal(err)
	}
	if collector.Vitals("node", when.Add(2*time.Minute), true) == nil {
		t.Fatal("fresh online sample missing")
	}
	if collector.Vitals("node", when.Add(4*time.Minute), true) != nil {
		t.Fatal("stale sample returned")
	}
	if collector.Vitals("node", when, false) != nil {
		t.Fatal("offline sample returned")
	}
}

func TestCollectorDropsStaleEpoch(t *testing.T) {
	epoch := credentials.NewEpoch()
	first, _ := epoch.Begin(context.Background())
	collector := NewCollector(nil, epoch, FieldAdapter{})
	second, _ := epoch.Begin(context.Background())
	if err := collector.Store("node", Vitals{CPU: 1}, first); err != nil {
		t.Fatal(err)
	}
	if collector.Vitals("node", time.Now(), true) != nil {
		t.Fatal("stale sample stored")
	}
	if err := collector.Store("node", Vitals{CPU: 2, SampledAt: time.Now()}, second); err != nil {
		t.Fatal(err)
	}
	if got := collector.Vitals("node", time.Now(), true); got == nil || got.CPU != 2 {
		t.Fatalf("current sample = %#v", got)
	}
}

func TestCollectorStoresPersistentTelemetryByIdentity(t *testing.T) {
	collector := NewCollector(nil, nil, FieldAdapter{})
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
	collector := NewCollector(nil, nil, FieldAdapter{})
	collector.SetInterval(time.Minute)
	when := time.Unix(100, 0).UTC()
	collector.StorePersistent("cid-1", PersistentTelemetry{SampledAt: when})

	if _, ok := collector.Persistent("cid-1", when.Add(4*time.Minute)); ok {
		t.Fatal("stale persistent telemetry returned")
	}
}
