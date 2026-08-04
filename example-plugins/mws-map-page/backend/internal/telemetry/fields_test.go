package telemetry

import (
	"testing"
	"time"
)

func TestParsePersistentTelemetryPreservesSystemAndRrdData(t *testing.T) {
	sampledAt := time.Unix(100, 0).UTC()
	sample, err := ParsePersistentTelemetry(
		[]byte(`{"uptime":90061,"cpuload":27,"memtotal":1000,"memory":"610/1024"}`),
		[]byte(`{"data":[{"t":"1","v":27},{"t":2,"v":31}]}`),
		[]byte(`{"data":[{"t":"1","v":610}]}`),
		sampledAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	if sample.System.CPULoad != 27 || sample.System.Memory != "610/1024" || sample.System.MemTotal != 1000 {
		t.Fatalf("system = %#v", sample.System)
	}
	if len(sample.CPURRD.Data) != 2 || len(sample.MemoryRRD.Data) != 1 {
		t.Fatalf("rrd data = %#v", sample)
	}
	if string(sample.CPURRD.Data[0].T) != `"1"` || sample.CPURRD.Data[1].V != 31 {
		t.Fatalf("cpu rrd = %#v", sample.CPURRD)
	}
	if !sample.SampledAt.Equal(sampledAt) {
		t.Fatalf("sampledAt = %v, want %v", sample.SampledAt, sampledAt)
	}
}

func TestParsePersistentTelemetryAllowsIndependentRrdFailures(t *testing.T) {
	sample, err := ParsePersistentTelemetry(
		[]byte(`{"uptime":"42","cpuload":1,"memtotal":100,"memory":"10/100"}`),
		nil,
		[]byte(`{"data":[{"t":1,"v":10}]}`),
		time.Unix(100, 0).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(sample.CPURRD.Data) != 0 {
		t.Fatalf("cpu rrd = %#v, want empty", sample.CPURRD.Data)
	}
	if len(sample.MemoryRRD.Data) != 1 {
		t.Fatalf("memory rrd = %#v, want one point", sample.MemoryRRD.Data)
	}
}

func TestFieldAdapterUsesExplicitFixturePaths(t *testing.T) {
	adapter := FieldAdapter{CPUPath: "system.cpu", MemoryUsedPath: "system.ram.used", MemoryTotalPath: "system.ram.total"}
	sampledAt := time.Unix(100, 0)
	vitals, err := adapter.Parse([]byte(`{"system":{"cpu":12.5,"ram":{"used":10,"total":100}}}`), sampledAt)
	if err != nil {
		t.Fatal(err)
	}
	if vitals.CPU != 12.5 || vitals.MemoryUsed != 10 || vitals.MemoryTotal != 100 || !vitals.SampledAt.Equal(sampledAt) {
		t.Fatalf("vitals = %#v", vitals)
	}
}
