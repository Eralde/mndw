package rrd

import (
	"context"
	"testing"
	"time"
)

type samplerFunc func(context.Context) ([]Value, error)

func (f samplerFunc) Poll(ctx context.Context) ([]Value, error) {
	return f(ctx)
}

func TestCollectorAcceptsIndependentSeriesAndRejectsDuplicateFiles(t *testing.T) {
	collector := NewCollector(&recordingExecutor{})
	series := &Series{
		File:  "/tmp/load.rrd",
		Step:  3 * time.Minute,
		DS:    testSpec().DS,
		Tiers: []Tier{{Every: 3 * time.Minute, Keep: 24 * time.Hour}},
		Sample: samplerFunc(func(context.Context) ([]Value, error) {
			return []Value{Known(1), Known(2)}, nil
		}),
	}

	if err := collector.Add(series); err != nil {
		t.Fatal(err)
	}

	if err := collector.Add(series); err == nil {
		t.Fatal("duplicate series accepted")
	}
}
