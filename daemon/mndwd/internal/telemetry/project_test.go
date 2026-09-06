package telemetry

import "testing"

func ptr(v float64) *float64 { return &v }

func TestProjectSeries_Empty(t *testing.T) {
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine":   {StepMs: 180000, Samples: []Sample{}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Points) != 0 {
		t.Errorf("expected 0 points, got %d", len(result.Points))
	}

	if len(result.Segments) != 0 {
		t.Errorf("expected 0 segments, got %d", len(result.Segments))
	}

	if len(result.Bands) != 0 {
		t.Errorf("expected 0 bands, got %d", len(result.Bands))
	}

	if result.ValueDomain != nil {
		t.Errorf("expected nil value domain for empty celsius, got %+v", result.ValueDomain)
	}
}

func TestProjectSeries_FineOnly7d(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now - 3*60*1000, Min: ptr(10), Max: ptr(30), Mean: ptr(20), OK: true},
				{Timestamp: now, Min: ptr(40), Max: ptr(60), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Points) != 2 {
		t.Fatalf("expected 2 points, got %d", len(result.Points))
	}

	if *result.Points[0].Value != 20 || *result.Points[1].Value != 50 {
		t.Errorf("expected values 20 and 50, got %v and %v", result.Points[0].Value, result.Points[1].Value)
	}

	if len(result.Segments) != 1 {
		t.Fatalf("expected 1 contiguous segment, got %d", len(result.Segments))
	}

	if len(result.Segments[0].Data) != 2 {
		t.Errorf("expected segment with 2 points, got %d", len(result.Segments[0].Data))
	}

	if result.ValueDomain == nil || result.ValueDomain.Min != 0 || result.ValueDomain.Max != 100 {
		t.Errorf("expected percent domain {0,100}, got %+v", result.ValueDomain)
	}
}

func TestProjectSeries_GapBreaksSegmentAndBand(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now - 6*60*1000, Min: ptr(10), Max: ptr(20), Mean: ptr(15), OK: true},
				{Timestamp: now - 3*60*1000, OK: false},
				{Timestamp: now, Min: ptr(40), Max: ptr(50), Mean: ptr(45), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Points) != 3 {
		t.Fatalf("expected 3 points, got %d", len(result.Points))
	}

	if result.Points[1].Value != nil {
		t.Errorf("expected nil value at gap, got %v", *result.Points[1].Value)
	}

	if len(result.Segments) != 2 {
		t.Errorf("expected 2 segments (split at gap), got %d", len(result.Segments))
	}

	if len(result.Bands) != 2 {
		t.Errorf("expected 2 bands (split at gap), got %d", len(result.Bands))
	}
}

func TestProjectSeries_CoarseFineMerge30d(t *testing.T) {
	now := int64(1_700_000_000_000)
	oldTs := now - 20*24*60*60*1000
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(40), Max: ptr(60), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: oldTs, Min: ptr(10), Max: ptr(30), Mean: ptr(20), OK: true},
			}},
		},
	}

	result := projectSeries(series, 30*24*60*60*1000)

	if len(result.Points) != 2 {
		t.Fatalf("expected 2 points (1 coarse + 1 fine), got %d", len(result.Points))
	}

	if result.Points[0].Time != oldTs {
		t.Errorf("expected first point at %d (coarse), got %d", oldTs, result.Points[0].Time)
	}

	if result.Points[1].Time != now {
		t.Errorf("expected second point at %d (fine), got %d", now, result.Points[1].Time)
	}

	if len(result.Segments) != 1 {
		t.Errorf("expected 1 contiguous segment, got %d", len(result.Segments))
	}
}

func TestProjectSeries_CoarseExcludedWhenFineCoversSameTimestamp(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(50), Max: ptr(50), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: now, Min: ptr(40), Max: ptr(40), Mean: ptr(40), OK: true},
			}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Points) != 1 {
		t.Fatalf("expected 1 point (coarse excluded by oldestFine), got %d", len(result.Points))
	}

	if *result.Points[0].Value != 50 {
		t.Errorf("expected fine value 50, got %v", *result.Points[0].Value)
	}
}

func TestProjectSeries_CelsiusDomain(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(42.3), Max: ptr(58.7), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if result.ValueDomain == nil {
		t.Fatal("expected celsius value domain")
	}

	if result.ValueDomain.Min != 40 || result.ValueDomain.Max != 61 {
		t.Errorf("expected domain {40,61}, got {%v,%v}", result.ValueDomain.Min, result.ValueDomain.Max)
	}
}

func TestProjectSeries_CelsiusEqualMinMax(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(50), Max: ptr(50), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if result.ValueDomain == nil {
		t.Fatal("expected celsius value domain")
	}

	if result.ValueDomain.Min != 45 || result.ValueDomain.Max != 55 {
		t.Errorf("expected domain {45,55}, got {%v,%v}", result.ValueDomain.Min, result.ValueDomain.Max)
	}
}

func TestProjectSeries_BandBreaksWhenMinMaxNil(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now - 6*60*1000, Min: ptr(40), Max: ptr(50), Mean: ptr(45), OK: true},
				{Timestamp: now - 3*60*1000, Min: nil, Max: nil, Mean: ptr(46), OK: true},
				{Timestamp: now, Min: ptr(42), Max: ptr(52), Mean: ptr(47), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Segments) != 1 {
		t.Errorf("expected 1 segment (no gap in ok), got %d", len(result.Segments))
	}

	if len(result.Bands) != 2 {
		t.Errorf("expected 2 bands (split at nil min/max), got %d", len(result.Bands))
	}
}

func TestProjectSeries_RangeClipping(t *testing.T) {
	now := int64(1_700_000_000_000)
	tooOld := now - 8*24*60*60*1000
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(50), Max: ptr(50), Mean: ptr(50), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: tooOld, Min: ptr(10), Max: ptr(10), Mean: ptr(10), OK: true},
			}},
		},
	}

	result := projectSeries(series, 7*24*60*60*1000)

	if len(result.Points) != 1 {
		t.Fatalf("expected 1 point (old coarse clipped), got %d", len(result.Points))
	}
}

func TestProjectSnapshot_AllKeys(t *testing.T) {
	now := int64(1_700_000_000_000)
	snapshot := &Snapshot{
		Keys: map[string]SeriesSnapshot{
			"cpu": {Label: "CPU", Supported: true, Unit: "percent", Tiers: map[string]TierSnapshot{
				"fine":   {Samples: []Sample{{Timestamp: now, Mean: ptr(50), OK: true, Min: ptr(40), Max: ptr(60)}}},
				"coarse": {Samples: []Sample{}},
			}},
			"temp": {Label: "cpu-thermal", Supported: false, Unit: "celsius", Tiers: map[string]TierSnapshot{
				"fine":   {Samples: []Sample{{Timestamp: now, Mean: ptr(55), OK: true, Min: ptr(50), Max: ptr(60)}}},
				"coarse": {Samples: []Sample{}},
			}},
		},
	}
	snapshot.Gathering.Enabled = true

	result := projectSnapshot(snapshot, 7*24*60*60*1000)

	if len(result.Keys) != 2 {
		t.Errorf("expected 2 keys, got %d", len(result.Keys))
	}

	if !result.Gathering.Enabled {
		t.Error("expected gathering enabled")
	}

	cpu := result.Keys["cpu"]

	if cpu.Label != "CPU" || !cpu.Supported || cpu.Unit != "percent" {
		t.Errorf("expected cpu metadata {CPU, true, percent}, got {%s, %v, %s}", cpu.Label, cpu.Supported, cpu.Unit)
	}

	temp := result.Keys["temp"]

	if temp.Label != "cpu-thermal" || temp.Supported || temp.Unit != "celsius" {
		t.Errorf("expected temp metadata {cpu-thermal, false, celsius}, got {%s, %v, %s}", temp.Label, temp.Supported, temp.Unit)
	}
}

func TestProjectSeries_1hRange_FineOnly(t *testing.T) {
	now := int64(1_700_000_000_000)
	inRange := now - 30*60*1000
	outOfRange := now - 2*60*60*1000
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: outOfRange, Min: ptr(30), Max: ptr(40), Mean: ptr(35), OK: true},
				{Timestamp: inRange, Min: ptr(42), Max: ptr(52), Mean: ptr(47), OK: true},
				{Timestamp: now, Min: ptr(50), Max: ptr(60), Mean: ptr(55), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: inRange, Min: ptr(99), Max: ptr(99), Mean: ptr(99), OK: true},
			}},
		},
	}

	result := projectSeries(series, 60*60*1000)

	if len(result.Points) != 2 {
		t.Fatalf("expected 2 points (1h clips oldest fine, excludes coarse), got %d", len(result.Points))
	}

	if result.Points[0].Time != inRange {
		t.Errorf("expected first point at %d, got %d", inRange, result.Points[0].Time)
	}

	for _, point := range result.Points {
		if point.Value != nil && *point.Value == 99 {
			t.Error("coarse sample leaked into fine-only 1h projection")
		}
	}
}

func TestProjectSeries_3hRange_FineOnly(t *testing.T) {
	now := int64(1_700_000_000_000)
	inRange := now - 2*60*60*1000
	outOfRange := now - 4*60*60*1000
	series := SeriesSnapshot{
		Unit: "celsius",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: outOfRange, Min: ptr(30), Max: ptr(40), Mean: ptr(35), OK: true},
				{Timestamp: inRange, Min: ptr(42), Max: ptr(52), Mean: ptr(47), OK: true},
				{Timestamp: now, Min: ptr(50), Max: ptr(60), Mean: ptr(55), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: inRange, Min: ptr(99), Max: ptr(99), Mean: ptr(99), OK: true},
			}},
		},
	}

	result := projectSeries(series, 3*60*60*1000)

	if len(result.Points) != 2 {
		t.Fatalf("expected 2 points (3h clips oldest fine, excludes coarse), got %d", len(result.Points))
	}

	for _, point := range result.Points {
		if point.Value != nil && *point.Value == 99 {
			t.Error("coarse sample leaked into fine-only 3h projection")
		}
	}
}

func TestProjectSeries_1dRange_MergesFineAndCoarse(t *testing.T) {
	now := int64(1_700_000_000_000)
	series := SeriesSnapshot{
		Unit: "percent",
		Tiers: map[string]TierSnapshot{
			"fine": {StepMs: 180000, Samples: []Sample{
				{Timestamp: now, Min: ptr(50), Max: ptr(60), Mean: ptr(55), OK: true},
			}},
			"coarse": {StepMs: 3600000, Samples: []Sample{
				{Timestamp: now - 20*60*60*1000, Min: ptr(30), Max: ptr(40), Mean: ptr(35), OK: true},
			}},
		},
	}

	result := projectSeries(series, 24*60*60*1000)

	if len(result.Points) != 2 {
		t.Fatalf("expected 2 points (both fine and coarse within 1d), got %d", len(result.Points))
	}
}
