package telemetry

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"mndw.local/rrd"

	"mndwd/internal/telemetry/journal"
)

// ErrUnanchoredSeries reports that a series' samples belong to a boot with no
// trustworthy anchor, so they cannot be placed on the calendar timeline.
var ErrUnanchoredSeries = errors.New("telemetry: series has no anchor for this boot")

// PublicationPlan is one cycle's canonical RRD updates for every series.
type PublicationPlan struct {
	Committed journal.Publication
	Points    map[uint16][]rrd.UpdatePoint
	Conflicts []uint64
	Coverage  []journal.Coverage
}

// publicationPageSize is the existing go-rrd update guard: at most 32 points
// per update command.
const publicationPageSize = 32

// BuildPublication maps journal records into canonical slot-aligned points for
// one boundary. It is pure: identical inputs produce identical output, which is
// what makes a rebuild reproduce delivered history.
func BuildPublication(records []journal.Record, prior journal.Publication) (PublicationPlan, error) {
	type anchorKey struct {
		boot    journal.BootID
		segment uint64
	}
	anchors := map[anchorKey]journal.Anchor{}
	firstAnchors := map[journal.BootID]journal.Anchor{}
	for _, record := range records {
		if record.Kind != journal.KindAnchor {
			continue
		}
		if prior.AnchorThrough > 0 && record.Seq > prior.AnchorThrough {
			continue
		}
		anchor, err := journal.DecodeAnchor(record)
		if err != nil {
			return PublicationPlan{}, err
		}
		key := anchorKey{boot: anchor.Boot, segment: anchor.ClockSegment}
		if existing, ok := anchors[key]; !ok || anchor.Seq >= existing.Seq {
			anchors[key] = anchor
		}
		if existing, ok := firstAnchors[anchor.Boot]; !ok || anchor.Seq < existing.Seq {
			firstAnchors[anchor.Boot] = anchor
		}
	}

	fixed := map[uint64]int64{}
	for _, frontier := range prior.Frontiers {
		fixed[uint64(frontier.Series)*1<<32+uint64(frontier.SlotMs>>8)] = frontier.SlotMs
	}

	slots := map[uint16]map[int64]journal.Sample{}
	conflicts := map[uint64]bool{}
	plan := PublicationPlan{Committed: prior, Points: map[uint16][]rrd.UpdatePoint{}}

	for _, record := range records {
		if record.Kind != journal.KindSample {
			continue
		}
		if prior.SampleThrough > 0 && record.Seq > prior.SampleThrough {
			// Records past the cutoff are not yet eligible for delivery; when
			// they land on a slot a durable boundary already fixed they are
			// retained as conflicts instead of rewriting history.
			sample, err := journal.DecodeSample(record)
			if err != nil {
				return PublicationPlan{}, err
			}
			anchor, ok := anchors[anchorKey{boot: sample.Boot, segment: sample.ClockSegment}]
			if !ok && sample.ClockSegment == 0 {
				anchor, ok = firstAnchors[sample.Boot]
			}
			if ok {
				if mapped, err := MapUTC(anchor, sample.ElapsedMs); err == nil {
					if isFixed(fixed, sample.Series, AlignSlot(mapped, stepForSeries(sample.Series))) {
						conflicts[sample.Seq] = true
					}
				}
			}
			continue
		}
		sample, err := journal.DecodeSample(record)
		if err != nil {
			return PublicationPlan{}, err
		}
		anchor, ok := anchors[anchorKey{boot: sample.Boot, segment: sample.ClockSegment}]
		if !ok && sample.ClockSegment == 0 {
			anchor, ok = firstAnchors[sample.Boot]
		}
		if !ok {
			continue
		}
		mapped, err := MapUTC(anchor, sample.ElapsedMs)
		if err != nil {
			continue
		}
		slot := AlignSlot(mapped, stepForSeries(sample.Series))
		bySlot, ok := slots[sample.Series]
		if !ok {
			bySlot = map[int64]journal.Sample{}
			slots[sample.Series] = bySlot
		}

		existing, ok := bySlot[slot]
		if !ok {
			bySlot[slot] = sample
			continue
		}

		// Within the cutoff the latest acquired record wins, reproducing the
		// selection the boundary froze; earlier arrivals stay conflicts.
		if sample.Seq > existing.Seq {
			conflicts[existing.Seq] = true
			bySlot[slot] = sample
			continue
		}
		conflicts[sample.Seq] = true
	}

	series := make([]uint16, 0, len(slots))
	for seriesID := range slots {
		series = append(series, seriesID)
	}
	sort.Slice(series, func(i, j int) bool { return series[i] < series[j] })

	for _, seriesID := range series {
		slotsForSeries := make([]int64, 0, len(slots[seriesID]))
		for slot := range slots[seriesID] {
			slotsForSeries = append(slotsForSeries, slot)
		}
		sort.Slice(slotsForSeries, func(i, j int) bool { return slotsForSeries[i] < slotsForSeries[j] })

		points := make([]rrd.UpdatePoint, 0, len(slotsForSeries))
		start := slotsForSeries[0]
		end := slotsForSeries[len(slotsForSeries)-1]
		for _, slot := range slotsForSeries {
			sample := slots[seriesID][slot]
			points = append(points, rrd.UpdatePoint{Timestamp: time.UnixMilli(slot).UTC(), Values: sampleValues(sample)})
		}
		plan.Points[seriesID] = points
		startMs, endMs := start, end
		plan.Coverage = append(plan.Coverage, journal.Coverage{
			Series:   seriesID,
			StartMs:  &startMs,
			EndMs:    &endMs,
			Complete: true,
		})
	}

	for sequence := range conflicts {
		plan.Conflicts = append(plan.Conflicts, sequence)
	}
	sort.Slice(plan.Conflicts, func(i, j int) bool { return plan.Conflicts[i] < plan.Conflicts[j] })

	return plan, nil
}

// PlanPublication streams records through BuildPublication and emits pages of
// at most 32 points per series so command size stays bounded.
func PlanPublication(
	ctx context.Context,
	reader func(func(journal.Record) error) error,
	prior journal.Publication,
	emit func(PublicationPlan) error,
) error {
	if reader == nil {
		return errors.New("telemetry: publication requires a record reader")
	}
	if emit == nil {
		return errors.New("telemetry: publication requires an emit function")
	}

	var records []journal.Record
	if err := reader(func(record journal.Record) error {
		records = append(records, record)
		return nil
	}); err != nil {
		return err
	}

	plan, err := BuildPublication(records, prior)
	if err != nil {
		return err
	}

	for seriesID, points := range plan.Points {
		pages, err := BatchPoints(points, publicationPageSize)
		if err != nil {
			return err
		}
		for _, page := range pages {
			if err := ctx.Err(); err != nil {
				return err
			}
			paged := PublicationPlan{Committed: prior, Coverage: plan.Coverage}
			paged.Points = map[uint16][]rrd.UpdatePoint{seriesID: page}
			if err := emit(paged); err != nil {
				return err
			}
		}
	}
	return nil
}

// BatchPoints splits an ordered point slice into pages of at most `size`.
func BatchPoints(points []rrd.UpdatePoint, size int) ([][]rrd.UpdatePoint, error) {
	if size < 1 || size > publicationPageSize {
		return nil, fmt.Errorf("telemetry: batch size %d outside 1..%d", size, publicationPageSize)
	}
	if len(points) == 0 {
		return nil, nil
	}

	pages := make([][]rrd.UpdatePoint, 0, (len(points)+size-1)/size)
	for start := 0; start < len(points); start += size {
		end := start + size
		if end > len(points) {
			end = len(points)
		}
		pages = append(pages, points[start:end])
	}
	return pages, nil
}

// SelectSlot resolves one destination slot. When a slot is already fixed by a
// durable boundary the previously fixed record wins; otherwise the latest
// acquired record wins and the others become conflicts.
func SelectSlot(existing *journal.Sample, candidates []journal.Sample) (journal.Sample, []uint64, error) {
	if existing == nil && len(candidates) == 0 {
		return journal.Sample{}, nil, errors.New("telemetry: slot selection needs a candidate")
	}

	// A slot already fixed by a durable boundary is immutable: the committed
	// record wins and every later arrival becomes a conflict.
	if existing != nil {
		conflicts := make([]uint64, 0, len(candidates))
		for _, candidate := range candidates {
			conflicts = append(conflicts, candidate.Seq)
		}
		return *existing, conflicts, nil
	}

	selected := journal.Sample{}
	have := false
	var conflicts []uint64
	for _, candidate := range candidates {
		if !have || candidate.Seq > selected.Seq {
			if have {
				conflicts = append(conflicts, selected.Seq)
			}
			selected = candidate
			have = true
			continue
		}
		conflicts = append(conflicts, candidate.Seq)
	}
	return selected, conflicts, nil
}

// stepForSeries returns the fine acquisition step of a series. Series 1 is
// load (cpu, ram) and series 2 is temperature in milli-Celsius.
func stepForSeries(series uint16) time.Duration {
	switch series {
	case 2:
		return 3 * time.Minute
	default:
		return 3 * time.Minute
	}
}

func sampleValues(sample journal.Sample) []rrd.Value {
	values := make([]rrd.Value, 0, len(sample.Values))
	for _, value := range sample.Values {
		values = append(values, rrd.Value{Known: value.Known, V: value.V})
	}
	return values
}

func isFixed(fixed map[uint64]int64, series uint16, slotMs int64) bool {
	value, ok := fixed[uint64(series)*1<<32+uint64(slotMs>>8)]
	if !ok {
		return false
	}
	return value == slotMs
}
