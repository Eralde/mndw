package telemetry

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

const (
	scenarioNowMs = int64(1_800_000_000_000)
	scenarioStep  = 3 * time.Minute
)

type scenarioRow struct {
	SlotStartMs         int64
	CPU, RAM, TempMilli float64
}

type snapshotScenario struct {
	Name          string
	NowMs         int64
	Anchored      bool
	ReplayPending bool
	TempSupported bool
	Rows          []scenarioRow
	WantStatus    string
	RingOnly      bool
}

type snapshotBuilder func(t *testing.T, sc snapshotScenario) *Snapshot

type snapshotScenarioGolden struct {
	Raw       *Snapshot                     `json:"raw"`
	Projected map[string]*ProjectedSnapshot `json:"projected"`
}

func snapshotScenarios() []snapshotScenario {
	base := time.UnixMilli(scenarioNowMs).UTC()
	full := fullScenarioRows(base)
	rowsAtEnd := []scenarioRow{knownScenarioRow(base.Add(-scenarioStep), 20, 40, 42_000)}

	coarseNow := base.Add(42 * time.Minute)
	coarseEnd := coarseNow.Truncate(time.Hour)
	coarseFallback := make([]scenarioRow, 0, 10)

	for index := 0; index < 10; index++ {
		coarseFallback = append(coarseFallback, knownScenarioRow(coarseEnd.Add(-time.Hour+time.Duration(index)*scenarioStep), 20, 40, 42_000))
	}

	oldNow := base.Add(4 * time.Hour)
	oldCoarseEnd := oldNow.Truncate(time.Hour)
	oldData := []scenarioRow{knownScenarioRow(oldCoarseEnd.Add(-2*time.Hour), 20, 40, 42_000)}

	thresholdNow := base.Add(2 * time.Hour)
	thresholdCoarseEnd := thresholdNow.Truncate(time.Hour)
	thresholdRows := make([]scenarioRow, 0, 19)

	for index := 0; index < 9; index++ {
		thresholdRows = append(thresholdRows, knownScenarioRow(thresholdCoarseEnd.Add(-2*time.Hour+time.Duration(index)*scenarioStep), 12.5, 37.75, 42_000))
	}

	for index := 0; index < 10; index++ {
		thresholdRows = append(thresholdRows, knownScenarioRow(thresholdCoarseEnd.Add(-time.Hour+time.Duration(index)*scenarioStep), 12.5, 37.75, 42_000))
	}

	gapRows := gapsAndUnknownScenarioRows(base)
	holeNow := base.Truncate(time.Hour).Add(time.Hour + 21*time.Minute)
	holeRows := holeScenarioRows(holeNow)
	partialRows := partialFirstHourScenarioRows(base)
	ringRebuild := ringRebuildScenario(base)
	ringCapacityEdge := ringCapacityEdgeScenario(base)
	ringNowFromOffset := ringNowFromOffsetScenario(base)

	return []snapshotScenario{
		{Name: "current-full", NowMs: scenarioNowMs, Anchored: true, TempSupported: true, Rows: full, WantStatus: "current"},
		{Name: "catching-up", NowMs: scenarioNowMs, Anchored: true, ReplayPending: true, TempSupported: true, Rows: full, WantStatus: "catching-up"},
		{Name: "historical-unanchored", NowMs: scenarioNowMs, TempSupported: true, Rows: rowsAtEnd, WantStatus: "historical"},
		{Name: "end-falls-to-coarse", NowMs: coarseNow.UnixMilli(), Anchored: true, TempSupported: true, Rows: coarseFallback, WantStatus: "current"},
		{Name: "empty-old-data", NowMs: oldNow.UnixMilli(), Anchored: true, TempSupported: true, Rows: oldData, WantStatus: "empty"},
		{Name: "hour-threshold", NowMs: thresholdNow.UnixMilli(), Anchored: true, TempSupported: true, Rows: thresholdRows, WantStatus: "current"},
		{Name: "gaps-and-unknowns", NowMs: scenarioNowMs, Anchored: true, TempSupported: true, Rows: gapRows, WantStatus: "current"},
		{Name: "hole-57-minutes", NowMs: holeNow.UnixMilli(), Anchored: true, TempSupported: true, Rows: holeRows, WantStatus: "current"},
		{Name: "partial-first-hour", NowMs: scenarioNowMs, Anchored: true, TempSupported: true, Rows: partialRows, WantStatus: "empty"},
		{Name: "temp-domain", NowMs: scenarioNowMs, Anchored: true, TempSupported: true, Rows: rowsAtEnd, WantStatus: "current"},
		{Name: "no-temp-sensor", NowMs: scenarioNowMs, Anchored: true, Rows: rowsAtEnd, WantStatus: "current"},
		{Name: "no-rows", NowMs: scenarioNowMs, Anchored: true, TempSupported: true, WantStatus: "empty"},
		ringRebuild,
		ringNowFromOffset,
		ringCapacityEdge,
	}
}

func runSnapshotScenarios(t *testing.T, build snapshotBuilder, includeRingOnly bool) {
	t.Helper()

	for _, scenario := range snapshotScenarios() {
		if scenario.RingOnly && !includeRingOnly {
			continue
		}

		scenario := scenario

		t.Run(scenario.Name, func(t *testing.T) {
			if !scenario.RingOnly {
				assertNoCurrentHourHoleFollowedByRow(t, scenario)
			}

			snapshot := build(t, scenario)

			if snapshot == nil {
				t.Fatal("snapshot builder returned nil")
			}

			got := snapshotScenarioGolden{Raw: snapshot, Projected: make(map[string]*ProjectedSnapshot, 5)}

			for name, rangeMs := range map[string]int64{
				"1h":  time.Hour.Milliseconds(),
				"3h":  (3 * time.Hour).Milliseconds(),
				"1d":  (24 * time.Hour).Milliseconds(),
				"7d":  (7 * 24 * time.Hour).Milliseconds(),
				"30d": (30 * 24 * time.Hour).Milliseconds(),
			} {
				got.Projected[name] = projectSnapshot(snapshot, rangeMs)
			}

			assertSnapshotScenario(t, scenario, snapshot)
			assertSnapshotScenarioDetails(t, scenario, snapshot, got.Projected)
			assertSnapshotScenarioGolden(t, scenario.Name, got)
		})
	}
}

// Scenario fixtures hold full raw and projected snapshots, about 3 MB of JSON
// each, so they are stored as gzip-compressed compact JSON.
func snapshotScenarioFixturePath(name string) string {
	return filepath.Join("testdata", "snapshot", name+".json.gz")
}

func readSnapshotScenarioGolden(t *testing.T, name string) snapshotScenarioGolden {
	t.Helper()

	fixturePath := snapshotScenarioFixturePath(name)
	file, err := os.Open(fixturePath)
	if err != nil {
		t.Fatalf("read fixture %s: %v (run this test once with -update, then review the fixture)", fixturePath, err)
	}

	defer func() { _ = file.Close() }()

	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatalf("open gzip fixture %s: %v", fixturePath, err)
	}

	var golden snapshotScenarioGolden

	if err := json.NewDecoder(reader).Decode(&golden); err != nil {
		t.Fatalf("decode fixture %s: %v", fixturePath, err)
	}

	return golden
}

func writeSnapshotScenarioGolden(t *testing.T, name string, got snapshotScenarioGolden) {
	t.Helper()

	fixturePath := snapshotScenarioFixturePath(name)
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("encode scenario %s: %v", name, err)
	}

	var compressed bytes.Buffer

	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := writer.Write(body); err != nil {
		t.Fatalf("compress fixture %s: %v", fixturePath, err)
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("compress fixture %s: %v", fixturePath, err)
	}

	if err := os.MkdirAll(filepath.Dir(fixturePath), 0o755); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}

	if err := os.WriteFile(fixturePath, compressed.Bytes(), 0o644); err != nil {
		t.Fatalf("write fixture %s: %v", fixturePath, err)
	}

	t.Logf("updated snapshot scenario fixture %s", fixturePath)
}

func assertSnapshotScenarioGolden(t *testing.T, name string, got snapshotScenarioGolden) {
	t.Helper()

	if *updateTelemetryGoldens {
		writeSnapshotScenarioGolden(t, name, got)

		return
	}

	want := readSnapshotScenarioGolden(t, name)

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scenario %s drifted from %s: %s", name, snapshotScenarioFixturePath(name), firstJSONDifference(t, got, want))
	}
}

// firstJSONDifference names the first differing JSON path, because a full
// scenario snapshot is too large to print.
func firstJSONDifference(t *testing.T, got, want any) string {
	t.Helper()

	gotValue := genericJSON(t, got)
	wantValue := genericJSON(t, want)

	if path, gotPart, wantPart, ok := jsonDifference("$", gotValue, wantValue); ok {
		gotJSON, _ := json.Marshal(gotPart)
		wantJSON, _ := json.Marshal(wantPart)

		return fmt.Sprintf("at %s\n got: %s\nwant: %s", path, gotJSON, wantJSON)
	}

	return "values differ only in Go types"
}

func genericJSON(t *testing.T, value any) any {
	t.Helper()

	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode for diff: %v", err)
	}

	var generic any

	if err := json.Unmarshal(body, &generic); err != nil {
		t.Fatalf("decode for diff: %v", err)
	}

	return generic
}

func jsonDifference(path string, got, want any) (string, any, any, bool) {
	gotObject, gotIsObject := got.(map[string]any)
	wantObject, wantIsObject := want.(map[string]any)

	if gotIsObject && wantIsObject {
		keys := make([]string, 0, len(gotObject)+len(wantObject))

		for key := range gotObject {
			keys = append(keys, key)
		}

		for key := range wantObject {
			if _, ok := gotObject[key]; !ok {
				keys = append(keys, key)
			}
		}

		sort.Strings(keys)

		for _, key := range keys {
			if diffPath, gotPart, wantPart, ok := jsonDifference(path+"."+key, gotObject[key], wantObject[key]); ok {
				return diffPath, gotPart, wantPart, true
			}
		}

		return "", nil, nil, false
	}

	gotArray, gotIsArray := got.([]any)
	wantArray, wantIsArray := want.([]any)

	if gotIsArray && wantIsArray && len(gotArray) == len(wantArray) {
		for index := range gotArray {
			if diffPath, gotPart, wantPart, ok := jsonDifference(fmt.Sprintf("%s[%d]", path, index), gotArray[index], wantArray[index]); ok {
				return diffPath, gotPart, wantPart, true
			}
		}

		return "", nil, nil, false
	}

	if reflect.DeepEqual(got, want) {
		return "", nil, nil, false
	}

	return path, got, want, true
}

func assertSnapshotScenario(t *testing.T, sc snapshotScenario, snapshot *Snapshot) {
	t.Helper()

	if got := sdkHistoryStatus(snapshot.Clock); got != sc.WantStatus {
		t.Fatalf("history status = %q, want %q (clock=%+v)", got, sc.WantStatus, snapshot.Clock)
	}
}

func assertSnapshotScenarioDetails(
	t *testing.T,
	sc snapshotScenario,
	snapshot *Snapshot,
	projected map[string]*ProjectedSnapshot,
) {
	t.Helper()

	switch sc.Name {
	case "current-full":
		assertHistoryEnd(t, snapshot, time.UnixMilli(sc.NowMs).UTC().Truncate(scenarioStep).UnixMilli())
	case "end-falls-to-coarse":
		assertHistoryEnd(t, snapshot, time.UnixMilli(sc.NowMs).UTC().Truncate(time.Hour).UnixMilli())

		if !snapshot.Clock.HistoryCurrent {
			t.Fatal("coarse fallback should be current when anchored without pending replay")
		}
	case "empty-old-data":
		assertHistoryEnd(t, snapshot, 0)
	case "hour-threshold":
		coarse := snapshot.Keys["cpu"].Tiers["coarse"].Samples
		wantUnknown := time.UnixMilli(sc.NowMs).UTC().Truncate(time.Hour).Add(-time.Hour).UnixMilli()
		wantKnown := time.UnixMilli(sc.NowMs).UTC().Truncate(time.Hour).UnixMilli()

		assertCoarseKnown(t, coarse, wantUnknown, false)
		assertCoarseKnown(t, coarse, wantKnown, true)
	case "gaps-and-unknowns":
		cpuPoints := projected["3h"].Keys["cpu"].Points
		gapCount := 0

		for _, point := range cpuPoints {
			if point.Value == nil {
				gapCount++
			}
		}

		if gapCount < 2 {
			t.Fatalf("3h CPU projection has %d unknown points, want the two-slot gap", gapCount)
		}

		coarseProjected := projected["30d"].Keys["cpu"]

		if !projectedPointsInSameSegment(coarseProjected, gapsUnknownHourEnd(sc.NowMs), gapsUnknownHourEnd(sc.NowMs)+time.Hour.Milliseconds()) {
			t.Fatal("in-hour NaN split the coarse CPU segment")
		}

		if hasPoint(projected["30d"].Keys["temp"].Points, gapsUnknownHourEnd(sc.NowMs)) {
			t.Fatal("unknown temperature was projected as a known value")
		}
	case "hole-57-minutes":
		points := projected["7d"].Keys["cpu"].Points
		fineStart := time.UnixMilli(sc.NowMs).UTC().Truncate(scenarioStep).Add(-24*time.Hour + scenarioStep).UnixMilli()
		coarseEnd := time.UnixMilli(sc.NowMs).UTC().Truncate(time.Hour).Add(-24 * time.Hour).UnixMilli()

		if !hasPoint(points, coarseEnd) || !hasPoint(points, fineStart) {
			t.Fatalf("7d projection lacks coarse/fine boundary points at %d and %d", coarseEnd, fineStart)
		}

		if gap := fineStart - coarseEnd; gap != (24 * time.Minute).Milliseconds() {
			t.Fatalf("coarse-to-fine boundary gap = %d ms, want 24 minutes", gap)
		}
	case "partial-first-hour":
		coarse := snapshot.Keys["cpu"].Tiers["coarse"].Samples

		if len(coarse) == 0 {
			t.Fatal("coarse tier has no first point")
		}

		if coarse[0].Mean == nil || *coarse[0].Mean != 12.5 {
			t.Fatalf("first coarse point = %+v, want known mean 12.5", coarse[0])
		}
	case "temp-domain":
		domain := projected["1h"].Keys["temp"].ValueDomain

		if domain == nil || domain.Min != 37 || domain.Max != 47 {
			t.Fatalf("temperature domain = %+v, want [37, 47]", domain)
		}
	case "no-temp-sensor":
		if snapshot.Keys["temp"].Supported {
			t.Fatal("unsupported temperature sensor reported as supported")
		}
	case "no-rows":
		for _, key := range []string{"cpu", "ram", "temp"} {
			for _, tierName := range []string{"fine", "coarse"} {
				tier := snapshot.Keys[key].Tiers[tierName]
				want := 480

				if tierName == "coarse" {
					want = 720
				}

				if len(tier.Samples) != want {
					t.Fatalf("%s %s rows = %d, want %d", key, tierName, len(tier.Samples), want)
				}

				for _, sample := range tier.Samples {
					if sample.OK || sample.Min != nil || sample.Max != nil || sample.Mean != nil {
						t.Fatalf("no-rows scenario produced known %s %s sample: %+v", key, tierName, sample)
					}
				}
			}
		}

		assertHistoryEnd(t, snapshot, 0)
	case "rebuild-within-delay":
		fine := snapshot.Keys["cpu"].Tiers["fine"].Samples

		if len(fine) == 0 || !fine[len(fine)-1].OK {
			t.Fatal("last fine point should be known when rebuilding within the delay")
		}
	case "capacity-edge":
		coarse := snapshot.Keys["cpu"].Tiers["coarse"].Samples

		if len(coarse) == 0 {
			t.Fatal("capacity-edge coarse tier is empty")
		}

		wantMean := (12.5 + 18*20) / 19

		if !coarse[0].OK || coarse[0].Mean == nil || *coarse[0].Mean != wantMean {
			var got any = nil

			if coarse[0].Mean != nil {
				got = *coarse[0].Mean
			}

			t.Fatalf("first coarse mean = %v, want %v including retained capacity-edge slot; sample=%+v", got, wantMean, coarse[0])
		}
	}
}

func ringRebuildScenario(base time.Time) snapshotScenario {
	rowSlot := base.UTC().Truncate(scenarioStep).Add(-scenarioStep)

	return snapshotScenario{
		Name:          "rebuild-within-delay",
		NowMs:         rowSlot.Add(2*scenarioStep + 5*time.Second).UnixMilli(),
		Anchored:      true,
		TempSupported: true,
		Rows:          []scenarioRow{knownScenarioRow(rowSlot, 20, 40, 42_000)},
		WantStatus:    "current",
		RingOnly:      true,
	}
}

func ringNowFromOffsetScenario(base time.Time) snapshotScenario {
	fineEnd := base.UTC().Add(-10 * time.Second).Truncate(scenarioStep)

	return snapshotScenario{
		Name:          "now-from-offset",
		NowMs:         scenarioNowMs,
		Anchored:      true,
		TempSupported: true,
		Rows:          []scenarioRow{knownScenarioRow(fineEnd.Add(-scenarioStep), 20, 40, 42_000)},
		WantStatus:    "current",
		RingOnly:      true,
	}
}

func ringCapacityEdgeScenario(base time.Time) snapshotScenario {
	coarseEnd := base.UTC().Truncate(time.Hour)
	coarseStart := coarseEnd.Add(-30 * 24 * time.Hour)
	rows := make([]scenarioRow, 0, 14_401)

	for slot, index := coarseStart, 0; slot.Before(coarseEnd); slot, index = slot.Add(scenarioStep), index+1 {
		cpu := 20.0

		if index == 0 {
			cpu = 12.5
		}

		rows = append(rows, knownScenarioRow(slot, cpu, 40, 42_000))
	}

	// The first current-hour slot is a hole. A later write leaves the oldest
	// slot physically present because this row is one slot beyond the ring wrap.
	rows = append(rows, knownScenarioRow(coarseEnd.Add(scenarioStep), 20, 40, 42_000))

	return snapshotScenario{
		Name:          "capacity-edge",
		NowMs:         coarseEnd.Add(2 * scenarioStep).UnixMilli(),
		Anchored:      true,
		TempSupported: true,
		Rows:          rows,
		WantStatus:    "current",
		RingOnly:      true,
	}
}

func assertNoCurrentHourHoleFollowedByRow(t *testing.T, sc snapshotScenario) {
	t.Helper()

	hourStart := time.UnixMilli(sc.NowMs).UTC().Truncate(time.Hour).UnixMilli()
	lastSlot := int64(-1)
	firstSlot := int64(-1)
	present := make(map[int64]bool)

	for _, row := range sc.Rows {
		if row.SlotStartMs < hourStart || row.SlotStartMs >= sc.NowMs {
			continue
		}

		present[row.SlotStartMs] = true

		if firstSlot < 0 || row.SlotStartMs < firstSlot {
			firstSlot = row.SlotStartMs
		}

		if row.SlotStartMs > lastSlot {
			lastSlot = row.SlotStartMs
		}
	}

	if firstSlot < 0 {
		return
	}

	for slot := firstSlot; slot <= lastSlot; slot += scenarioStep.Milliseconds() {
		if !present[slot] {
			t.Fatalf("shared scenario %q has a hole in the current partial hour at slot %d followed by a later row", sc.Name, slot)
		}
	}
}

func sdkHistoryStatus(metadata *ClockMetadata) string {
	// Mirrors frontend/sdk/src/telemetry-client.ts:625 historyStatus.
	if metadata == nil {
		return "legacy"
	}

	if metadata.HistoryEndMs == nil {
		return "empty"
	}

	if metadata.HistoryCurrent {
		return "current"
	}

	if metadata.ReplayPending {
		return "catching-up"
	}

	return "historical"
}

func fullScenarioRows(now time.Time) []scenarioRow {
	end := now.UTC().Truncate(time.Hour)
	start := end.Add(-30 * 24 * time.Hour)
	rows := make([]scenarioRow, 0, 14_400)

	for slot := start; slot.Before(end); slot = slot.Add(scenarioStep) {
		rows = append(rows, knownScenarioRow(slot, 20, 40, 42_000))
	}

	return rows
}

func gapsAndUnknownScenarioRows(now time.Time) []scenarioRow {
	rows := make([]scenarioRow, 0, 60)
	fineEnd := now.UTC().Truncate(scenarioStep)
	fineStart := fineEnd.Add(-3 * time.Hour)

	for slot, index := fineStart, 0; slot.Before(fineEnd); slot, index = slot.Add(scenarioStep), index+1 {
		if index == 12 || index == 13 {
			continue
		}

		rows = append(rows, knownScenarioRow(slot, 20, 40, math.NaN()))
	}

	coarseEnd := now.UTC().Truncate(time.Hour)
	oldHourStart := coarseEnd.Add(-48 * time.Hour)

	for index := 0; index < 40; index++ {
		cpu := 20.0
		ram := 40.0

		if index == 5 {
			cpu = math.NaN()
		}

		rows = append(rows, knownScenarioRow(oldHourStart.Add(time.Duration(index)*scenarioStep), cpu, ram, math.NaN()))
	}

	return rows
}

func holeScenarioRows(now time.Time) []scenarioRow {
	rows := make([]scenarioRow, 0, 490)
	fineEnd := now.UTC().Truncate(scenarioStep)
	fineStart := fineEnd.Add(-24 * time.Hour)

	for slot := fineStart; slot.Before(fineEnd); slot = slot.Add(scenarioStep) {
		rows = append(rows, knownScenarioRow(slot, 20, 40, 42_000))
	}

	coarseEnd := now.UTC().Truncate(time.Hour).Add(-24 * time.Hour)

	for index := 0; index < 10; index++ {
		rows = append(rows, knownScenarioRow(coarseEnd.Add(-time.Hour+time.Duration(index)*scenarioStep), 20, 40, 42_000))
	}

	return rows
}

func partialFirstHourScenarioRows(now time.Time) []scenarioRow {
	coarseStart := now.UTC().Truncate(time.Hour).Add(-30 * 24 * time.Hour)
	rows := make([]scenarioRow, 0, 10)

	for index := 0; index < 10; index++ {
		rows = append(rows, knownScenarioRow(coarseStart.Add(time.Duration(index)*scenarioStep), 12.5, 37.75, 42_500))
	}

	return rows
}

func knownScenarioRow(slot time.Time, cpu, ram, temp float64) scenarioRow {
	return scenarioRow{SlotStartMs: slot.UTC().UnixMilli(), CPU: cpu, RAM: ram, TempMilli: temp}
}

func scenarioValue(value float64) Value {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return Value{}
	}

	return Value{V: float64(float32(value)), Known: true}
}

func assertHistoryEnd(t *testing.T, snapshot *Snapshot, want int64) {
	t.Helper()

	if want == 0 {
		if snapshot.Clock.HistoryEndMs != nil {
			t.Fatalf("historyEndMs = %d, want nil", *snapshot.Clock.HistoryEndMs)
		}

		return
	}

	if snapshot.Clock.HistoryEndMs == nil || *snapshot.Clock.HistoryEndMs != want {
		t.Fatalf("historyEndMs = %v, want %d", snapshot.Clock.HistoryEndMs, want)
	}
}

func assertCoarseKnown(t *testing.T, samples []Sample, timestamp int64, wantKnown bool) {
	t.Helper()

	for _, sample := range samples {
		if sample.Timestamp != timestamp {
			continue
		}

		if sample.OK != wantKnown {
			t.Fatalf("coarse sample at %d known=%t, want %t", timestamp, sample.OK, wantKnown)
		}

		return
	}

	t.Fatalf("coarse sample at %d not found", timestamp)
}

func projectedPointsInSameSegment(series ProjectedSeries, first, second int64) bool {
	for _, segment := range series.Segments {
		firstFound := false
		secondFound := false

		for _, point := range segment.Data {
			if point.Value == nil {
				continue
			}

			if point.Time == first {
				firstFound = true
			}

			if point.Time == second {
				secondFound = true
			}
		}

		if firstFound && secondFound {
			return true
		}
	}

	return false
}

func gapsUnknownHourEnd(nowMs int64) int64 {
	return time.UnixMilli(nowMs).UTC().Truncate(time.Hour).Add(-48*time.Hour + time.Hour).UnixMilli()
}

func hasPoint(points []ProjectedPoint, timestamp int64) bool {
	for _, point := range points {
		if point.Time == timestamp && point.Value != nil {
			return true
		}
	}

	return false
}
