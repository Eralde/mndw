package telemetry

import (
	"context"
	"testing"

	rci "mndw.local/rci"
)

func TestLoadSamplerReadsCPUAndRAMTogether(t *testing.T) {
	client, err := rci.New(rci.TransportFunc(func(context.Context, []byte) (rci.Response, error) {
		return rci.Response{Status: 200, Body: []byte(`[{"show":{"system":{"cpuload":27,"memtotal":1000,"memory":"610/1024"}}}]`)}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}

	values, err := NewLoadSampler(client).Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if !values[0].Known || values[0].V != 27 || !values[1].Known || values[1].V != 61 {
		t.Fatalf("values %#v", values)
	}
}
