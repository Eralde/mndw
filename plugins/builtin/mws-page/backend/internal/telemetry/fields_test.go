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

func TestParsePersistentTelemetryRejectsMalformedRrdResponse(t *testing.T) {
	_, err := ParsePersistentTelemetry(
		[]byte(`{"uptime":"42","cpuload":1,"memtotal":100,"memory":"10/100"}`),
		[]byte(`{"data":{"unexpected":true}}`),
		[]byte(`{"data":[{"t":1,"v":10}]}`),
		time.Unix(100, 0).UTC(),
	)
	if err == nil {
		t.Fatal("parse error = nil, want malformed CPU RRD response error")
	}
}

func TestParseWifiUtilizationExtractsPerSampleTimeAndLoad(t *testing.T) {
	times, loads, err := ParseWifiUtilization([]byte(`{"ch":3,"bw":"20","data":[{"t":4562,"v":{"load":28,"flags":"v"}},{"t":4565,"v":{"load":31,"flags":"v"}}]}`))
	if err != nil {
		t.Fatal(err)
	}

	if len(times) != 2 || times[0] != 4562 || times[1] != 4565 {
		t.Fatalf("times = %#v, want 4562,4565", times)
	}

	if len(loads) != 2 || loads[0] != 28 || loads[1] != 31 {
		t.Fatalf("loads = %#v, want 28,31", loads)
	}
}

func TestParseWifiUtilizationTreatsEmptyPayloadAsNoData(t *testing.T) {
	for _, payload := range [][]byte{nil, []byte(`{"data":[]}`)} {
		times, loads, err := ParseWifiUtilization(payload)
		if err != nil {
			t.Fatalf("payload %q: %v", payload, err)
		}

		if times != nil || loads != nil {
			t.Fatalf("payload %q times/loads = %#v/%#v, want nil", payload, times, loads)
		}
	}
}

func TestParseWifiUtilizationRejectsMalformedPayload(t *testing.T) {
	if _, _, err := ParseWifiUtilization([]byte(`{"data":"malformed"}`)); err == nil {
		t.Fatal("error = nil, want decode failure")
	}
}
