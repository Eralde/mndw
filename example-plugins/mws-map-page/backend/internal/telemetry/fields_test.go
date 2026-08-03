package telemetry

import (
	"testing"
	"time"
)

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
