package publication

import (
	"context"
	"testing"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

func anchorFor(t *testing.T, boot journal.BootID, elapsedMs, utcMs int64) journal.Record {
	t.Helper()

	prepared, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ElapsedMs: elapsedMs, UTCMs: utcMs, EvidenceID: "ev", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	return journal.Record{Kind: prepared.Kind, Seq: 1, Payload: prepared.Payload}
}

func sampleFor(t *testing.T, seq uint64, boot journal.BootID, series uint16, elapsedMs int64, values ...journal.Value) journal.Record {
	t.Helper()

	prepared, err := journal.PrepareSample(journal.Sample{Seq: 0, Boot: boot, Series: series, ElapsedMs: elapsedMs, Values: values})
	if err != nil {
		t.Fatal(err)
	}

	return journal.Record{Kind: prepared.Kind, Seq: seq, Payload: prepared.Payload}
}

func TestSelectSlotKeepsPreviouslyFixedRecord(t *testing.T) {
	fixed := journal.Sample{Seq: 10, Series: 1, Values: []journal.Value{{Known: true, V: 20}}}
	later := journal.Sample{Seq: 11, Series: 1, Values: []journal.Value{{Known: true, V: 80}}}
	selected, conflicts, err := SelectSlot(&fixed, []journal.Sample{later})
	if err != nil {
		t.Fatal(err)
	}

	if selected.Seq != 10 || len(conflicts) != 1 || conflicts[0] != 11 {
		t.Fatalf("canonical slot changed: %d %v", selected.Seq, conflicts)
	}
}

func TestSelectSlotPicksLatestWhenUnfixed(t *testing.T) {
	older := journal.Sample{Seq: 10, Values: []journal.Value{{Known: true, V: 20}}}
	newer := journal.Sample{Seq: 12, Values: []journal.Value{{Known: true, V: 80}}}
	selected, conflicts, err := SelectSlot(nil, []journal.Sample{older, newer})
	if err != nil {
		t.Fatal(err)
	}

	if selected.Seq != 12 || len(conflicts) != 1 || conflicts[0] != 10 {
		t.Fatalf("selection=%d conflicts=%v", selected.Seq, conflicts)
	}
}

func TestBuildPublicationMapsAnchoredSamplesToSlots(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, boot, 0, 1800000000000),
		sampleFor(t, 2, boot, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, boot, 1, 180000, journal.Value{Known: true, V: 30}, journal.Value{Known: true, V: 50}),
	}

	plan, err := BuildPublication(records, journal.Publication{SampleThrough: 3, AnchorThrough: 1})
	if err != nil {
		t.Fatal(err)
	}

	points := plan.Points[1]

	if len(points) != 2 {
		t.Fatalf("points=%d", len(points))
	}

	if points[0].Timestamp.UnixMilli() != 1800000000000 {
		t.Fatalf("first slot=%d", points[0].Timestamp.UnixMilli())
	}

	if points[1].Timestamp.UnixMilli() != 1800000180000 {
		t.Fatalf("second slot=%d", points[1].Timestamp.UnixMilli())
	}

	if len(points[0].Values) != 2 || !points[0].Values[0].Known {
		t.Fatalf("values=%+v", points[0].Values)
	}
}

func TestBuildPublicationSkipsUnanchoredBoot(t *testing.T) {
	anchored := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, anchored, 0, 1800000000000),
		sampleFor(t, 2, anchored, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, journal.BootID{2}, 1, 180000, journal.Value{Known: true, V: 30}, journal.Value{Known: true, V: 50}),
	}
	plan, err := BuildPublication(records, journal.Publication{SampleThrough: 3, AnchorThrough: 1})
	if err != nil {
		t.Fatal(err)
	}

	if len(plan.Points[1]) != 1 {
		t.Fatalf("unanchored boot blocked delivery: %+v", plan.Points)
	}
}

func TestBuildPublicationUsesClockSegmentAndMapsPreAnchorSamples(t *testing.T) {
	boot := journal.BootID{1}
	first, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 60000, UTCMs: 1800000000000, EvidenceID: "ev-1", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	second, err := journal.PrepareAnchor(journal.Anchor{Boot: boot, ClockSegment: 2, ElapsedMs: 120000, UTCMs: 1800003600000, EvidenceID: "ev-2", EvidenceSource: "fixture"})
	if err != nil {
		t.Fatal(err)
	}

	preAnchor, err := journal.PrepareSample(journal.Sample{Boot: boot, Series: 1, ElapsedMs: 0, Values: []journal.Value{{Known: true, V: 10}}})
	if err != nil {
		t.Fatal(err)
	}

	segmentOne, err := journal.PrepareSample(journal.Sample{Boot: boot, ClockSegment: 1, Series: 1, ElapsedMs: 60000, Values: []journal.Value{{Known: true, V: 20}}})
	if err != nil {
		t.Fatal(err)
	}

	segmentTwo, err := journal.PrepareSample(journal.Sample{Boot: boot, ClockSegment: 2, Series: 1, ElapsedMs: 120000, Values: []journal.Value{{Known: true, V: 30}}})
	if err != nil {
		t.Fatal(err)
	}

	records := []journal.Record{
		{Kind: preAnchor.Kind, Seq: 1, Payload: preAnchor.Payload},
		{Kind: first.Kind, Seq: 2, Payload: first.Payload},
		{Kind: segmentOne.Kind, Seq: 3, Payload: segmentOne.Payload},
		{Kind: second.Kind, Seq: 4, Payload: second.Payload},
		{Kind: segmentTwo.Kind, Seq: 5, Payload: segmentTwo.Payload},
	}
	plan, err := BuildPublication(records, journal.Publication{SampleThrough: 5, AnchorThrough: 4})
	if err != nil {
		t.Fatal(err)
	}

	points := plan.Points[1]

	if len(points) != 3 {
		t.Fatalf("points=%d, want pre-anchor and both segments", len(points))
	}

	if points[0].Timestamp.UnixMilli() != 1799999820000 {
		t.Fatalf("pre-anchor mapping=%d", points[0].Timestamp.UnixMilli())
	}

	if points[2].Timestamp.UnixMilli() != 1800003600000 {
		t.Fatalf("second segment mapping=%d", points[2].Timestamp.UnixMilli())
	}
}

func TestBuildPublicationHonorsFixedFrontier(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, boot, 0, 1800000000000),
		sampleFor(t, 2, boot, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, boot, 1, 60000, journal.Value{Known: true, V: 90}, journal.Value{Known: true, V: 95}),
	}
	boundary := journal.Publication{
		SampleThrough: 3,
		AnchorThrough: 1,
		Frontiers:     []journal.Frontier{{Series: 1, SlotMs: 1800000000000}},
	}
	plan, err := BuildPublication(records, boundary)
	if err != nil {
		t.Fatal(err)
	}

	// Within the cutoff the original selection is reproduced: latest acquired
	// wins, and the earlier colliding record is retained as a conflict.
	if len(plan.Points[1]) != 1 || plan.Points[1][0].Values[0].V != 90 {
		t.Fatalf("fixed slot selection=%+v", plan.Points[1])
	}

	if len(plan.Conflicts) != 1 || plan.Conflicts[0] != 2 {
		t.Fatalf("conflicts=%v", plan.Conflicts)
	}
}

func TestBuildPublicationConflictsBeyondFixedFrontier(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, boot, 0, 1800000000000),
		sampleFor(t, 2, boot, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, boot, 1, 60000, journal.Value{Known: true, V: 90}, journal.Value{Known: true, V: 95}),
	}
	boundary := journal.Publication{
		SampleThrough: 2,
		AnchorThrough: 1,
		Frontiers:     []journal.Frontier{{Series: 1, SlotMs: 1800000000000}},
	}
	plan, err := BuildPublication(records, boundary)
	if err != nil {
		t.Fatal(err)
	}

	if len(plan.Points[1]) != 1 || plan.Points[1][0].Values[0].V != 20 {
		t.Fatalf("committed slot changed: %+v", plan.Points[1])
	}

	if len(plan.Conflicts) != 1 || plan.Conflicts[0] != 3 {
		t.Fatalf("late arrival not retained as conflict: %v", plan.Conflicts)
	}
}

func TestBuildPublicationIncludesNewRecordsWhenCutoffExtended(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, boot, 0, 1800000000000),
		sampleFor(t, 2, boot, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, boot, 1, 180000, journal.Value{Known: true, V: 30}, journal.Value{Known: true, V: 50}),
	}
	// Simulate a second publication cycle: prior boundary committed through
	// seq 2 with its frontier, but the effective cutoff now reaches seq 3.
	effective := journal.Publication{
		SampleThrough: 3,
		AnchorThrough: 3,
		Frontiers:     []journal.Frontier{{Series: 1, SlotMs: 1800000000000}},
	}
	plan, err := BuildPublication(records, effective)
	if err != nil {
		t.Fatal(err)
	}

	points := plan.Points[1]

	if len(points) != 2 {
		t.Fatalf("expected both slots, got %d points", len(points))
	}

	if points[1].Timestamp.UnixMilli() != 1800000180000 {
		t.Fatalf("new record slot=%d", points[1].Timestamp.UnixMilli())
	}
}

func TestBuildPublicationIsDeterministic(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{
		anchorFor(t, boot, 0, 1800000000000),
		sampleFor(t, 2, boot, 1, 0, journal.Value{Known: true, V: 20}, journal.Value{Known: true, V: 40}),
		sampleFor(t, 3, boot, 1, 60000, journal.Value{Known: true, V: 25}, journal.Value{Known: true, V: 45}),
	}
	first, err := BuildPublication(records, journal.Publication{SampleThrough: 3, AnchorThrough: 1})
	if err != nil {
		t.Fatal(err)
	}

	second, err := BuildPublication(records, journal.Publication{SampleThrough: 3, AnchorThrough: 1})
	if err != nil {
		t.Fatal(err)
	}

	if len(first.Points[1]) != len(second.Points[1]) {
		t.Fatal("rebuild produced different point counts")
	}

	for i := range first.Points[1] {
		if !first.Points[1][i].Timestamp.Equal(second.Points[1][i].Timestamp) {
			t.Fatalf("slot %d differs", i)
		}

		if first.Points[1][i].Values[0].V != second.Points[1][i].Values[0].V {
			t.Fatalf("value %d differs", i)
		}
	}
}

func TestFourHourReplayUsesThreeCommandsPerSeries(t *testing.T) {
	points := make([]rrd.UpdatePoint, 80)
	batches, err := BatchPoints(points, 32)
	if err != nil {
		t.Fatal(err)
	}

	if len(batches) != 3 || len(batches[2]) != 16 {
		t.Fatalf("unexpected batches: %v", batches)
	}

	if _, err := BatchPoints(points, 0); err == nil {
		t.Fatal("accepted batch size 0")
	}

	if _, err := BatchPoints(points, 33); err == nil {
		t.Fatal("accepted batch size above the update guard")
	}
}

func TestPlanPublicationEmitsBoundedPages(t *testing.T) {
	boot := journal.BootID{1}
	records := []journal.Record{anchorFor(t, boot, 0, 1800000000000)}

	for i := 0; i < 80; i++ {
		records = append(records, sampleFor(t, uint64(i+2), boot, 1, int64(i)*180000, journal.Value{Known: true, V: 1}, journal.Value{Known: true, V: 2}))
	}

	pages := 0
	points := 0
	err := PlanPublication(context.Background(), func(visit func(journal.Record) error) error {
		for _, record := range records {
			if err := visit(record); err != nil {
				return err
			}
		}

		return nil
	}, journal.Publication{SampleThrough: 100, AnchorThrough: 1}, func(plan PublicationPlan) error {
		pages++

		for _, seriesPoints := range plan.Points {
			points += len(seriesPoints)

			if len(seriesPoints) > 32 {
				t.Fatalf("page with %d points", len(seriesPoints))
			}
		}

		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if pages != 3 || points != 80 {
		t.Fatalf("pages=%d points=%d", pages, points)
	}
}

func TestDetectBoundariesForRebootAndGap(t *testing.T) {
	bootA := journal.BootID{1}
	bootB := journal.BootID{2}
	anchors := map[journal.BootID]journal.Anchor{
		bootA: {Boot: bootA, ElapsedMs: 0, UTCMs: 1800000000000},
		bootB: {Boot: bootB, ElapsedMs: 0, UTCMs: 1800003600000},
	}
	lookup := func(boot journal.BootID) (journal.Anchor, bool) {
		anchor, ok := anchors[boot]

		return anchor, ok
	}

	samples := []journal.Sample{
		{Boot: bootA, Series: 1, ElapsedMs: 0},
		{Boot: bootA, Series: 1, ElapsedMs: 180000},
		{Boot: bootB, Series: 1, ElapsedMs: 0},
		{Boot: bootB, Series: 1, ElapsedMs: 3600000},
	}

	boundaries, err := DetectBoundaries(samples, lookup, 390*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	kinds := map[BoundaryKind]int{}

	for _, boundary := range boundaries {
		kinds[boundary.Kind]++
	}

	if kinds[BoundaryReboot] != 1 {
		t.Fatalf("reboot boundaries=%d", kinds[BoundaryReboot])
	}

	if kinds[BoundaryHeartbeat] != 1 {
		t.Fatalf("gap boundaries=%d", kinds[BoundaryHeartbeat])
	}
}

func TestUnknownBoundaryPrefersExplicitUnknown(t *testing.T) {
	boundary := UnknownBoundary{Series: 1, Kind: BoundaryReboot, SlotMs: 1800000000000}
	points := UnknownBoundaryPoints(boundary, CurrentUnknownBoundaryMode)

	if len(points) != 1 {
		t.Fatalf("points=%d", len(points))
	}

	if len(points[0].Values) != 2 || points[0].Values[0].Known {
		t.Fatalf("values=%+v", points[0].Values)
	}

	if len(UnknownBoundaryPoints(boundary, UnknownBoundarySkip)) != 0 {
		t.Fatal("skip mode emitted updates")
	}
}
