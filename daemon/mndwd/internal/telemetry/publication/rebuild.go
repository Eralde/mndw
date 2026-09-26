package publication

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

// rebuildScratchPrefix marks rebuild scratch directories so recovery can remove
// only identifiable orphans.
const rebuildScratchPrefix = ".rrd-rebuild-"

// rebuildAll reconstructs every destination from retained journal records.
func (d *DerivedStore) rebuildAll(ctx context.Context) error {
	series := make([]uint16, 0, len(d.destinations))

	for seriesID := range d.destinations {
		series = append(series, seriesID)
	}

	sortSeries(series)

	for _, seriesID := range series {
		if err := d.rebuildSeries(ctx, seriesID); err != nil {
			return err
		}
	}

	return nil
}

// rebuildSeries rebuilds one destination file: build a scratch RRD from the
// earliest retained mapped record, validate it, then atomically install it.
func (d *DerivedStore) rebuildSeries(ctx context.Context, series uint16) error {
	destination, ok := d.destination(series)

	if !ok {
		return nil
	}

	lease, err := d.storage.Acquire(ctx)
	if err != nil {
		return err
	}

	defer func() { _ = lease.Close() }()

	if lease.Result.Reader == nil {
		return ErrDerivedUnavailable
	}

	pin, err := pinDurable(lease)
	if err != nil {
		return err
	}

	if pin != nil {
		defer func() { _ = pin.Close() }()
	}

	records, earliestMs, prior, err := collectMappedRecords(ctx, lease.Result.Reader, series)
	if err != nil {
		return err
	}

	if earliestMs == 0 {
		// No mapped sample of this series is retained: nothing to rebuild.
		return nil
	}

	scratchDir, err := d.fs.MkdirTemp(d.paths.RRDDir, rebuildScratchPrefix)
	if err != nil {
		return err
	}

	scratchPath := filepath.Join(scratchDir, "data.rrd")

	scratch, err := d.factory.Open(scratchPath, destination.spec, fileOpsAdapter{fs: d.fs})
	if err != nil {
		return err
	}

	if err := scratch.Ensure(ctx, time.UnixMilli(earliestMs).UTC()); err != nil {
		return err
	}

	latestPublished := int64(0)
	err = PlanPublication(ctx, func(visit func(journal.Record) error) error {
		for _, record := range records {
			if err := visit(record); err != nil {
				return err
			}
		}

		return nil
	}, prior, func(plan PublicationPlan) error {
		points, ok := plan.Points[series]

		if !ok {
			return nil
		}

		if len(points) > 0 && points[len(points)-1].Timestamp.UnixMilli() > latestPublished {
			latestPublished = points[len(points)-1].Timestamp.UnixMilli()
		}

		return scratch.Update(ctx, points)
	})
	if err != nil {
		_ = d.fs.Remove(scratchPath)

		return err
	}

	if err := syncFile(d.fs, scratchPath); err != nil {
		return err
	}

	if err := d.fs.Rename(scratchPath, destination.path); err != nil {
		return err
	}

	if err := d.fs.SyncDir(d.paths.RRDDir); err != nil {
		return err
	}

	_ = d.fs.Remove(scratchDir)

	// Reopen the destination handle after replacement.
	file, err := d.factory.Open(destination.path, destination.spec, fileOpsAdapter{fs: d.fs})
	if err != nil {
		return err
	}

	d.mu.Lock()

	destination.file = file
	destination.rebuilt = true

	if latestPublished != 0 {
		destination.slotMs = latestPublished
	}

	d.mutated = true

	d.mu.Unlock()

	return nil
}

// collectMappedRecords gathers records for one series together with the earliest
// mapped timestamp that can be reconstructed.
func collectMappedRecords(
	ctx context.Context,
	reader *journal.Reader,
	series uint16,
) ([]journal.Record, int64, journal.Publication, error) {
	anchors := map[struct {
		boot    journal.BootID
		segment uint64
	}]journal.Anchor{}
	var records []journal.Record
	var prior journal.Publication
	earliest := int64(0)

	err := reader.Scan(ctx, func(record journal.Record) error {
		records = append(records, record)

		if record.Kind == journal.KindPublication {
			publication, decodeErr := journal.DecodePublication(record)

			if decodeErr != nil {
				return decodeErr
			}

			if publication.Seq >= prior.Seq {
				prior = publication
			}
		}

		if record.Kind == journal.KindAnchor {
			anchor, decodeErr := journal.DecodeAnchor(record)

			if decodeErr == nil {
				key := struct {
					boot    journal.BootID
					segment uint64
				}{anchor.Boot, anchor.ClockSegment}

				if existing, ok := anchors[key]; !ok || anchor.Seq >= existing.Seq {
					anchors[key] = anchor
				}
			}
		}

		return nil
	})
	if err != nil {
		return nil, 0, journal.Publication{}, err
	}

	filtered := make([]journal.Record, 0, len(records))
	firstAnchors := map[journal.BootID]journal.Anchor{}

	for _, record := range records {
		if record.Kind == journal.KindAnchor {
			anchor, decodeErr := journal.DecodeAnchor(record)

			if decodeErr == nil {
				if existing, ok := firstAnchors[anchor.Boot]; !ok || anchor.Seq < existing.Seq {
					firstAnchors[anchor.Boot] = anchor
				}
			}
		}
	}

	for _, record := range records {
		if record.Kind != journal.KindSample {
			if record.Kind == journal.KindAnchor {
				filtered = append(filtered, record)
			}

			continue
		}

		sample, decodeErr := journal.DecodeSample(record)

		if decodeErr != nil || sample.Series != series {
			continue
		}

		anchor, ok := anchors[struct {
			boot    journal.BootID
			segment uint64
		}{sample.Boot, sample.ClockSegment}]

		if !ok && sample.ClockSegment == 0 {
			anchor, ok = firstAnchors[sample.Boot]
		}

		if !ok {
			continue
		}

		mapped, mapErr := clock.MapUTC(anchor, sample.ElapsedMs)

		if mapErr != nil {
			continue
		}

		if earliest == 0 || mapped < earliest {
			earliest = mapped
		}

		filtered = append(filtered, record)
	}

	return filtered, earliest, prior, nil
}

// pinDurable pins retained inputs while a writer is available.
func pinDurable(lease journal.StorageLease) (*journal.Lease, error) {
	if lease.Result.Writer == nil {
		return nil, nil
	}

	return lease.Result.Writer.Pin(lease.Result.Writer.DurableThrough())
}

// syncFile synchronizes one file through the injected filesystem. An absent
// file has nothing durable to flush, which only happens with a fake factory.
func syncFile(fs journal.FileSystem, path string) error {
	file, err := fs.OpenFile(path, os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}

		return err
	}

	defer func() { _ = file.Close() }()

	return file.Sync()
}

// cleanupRebuildScratch removes identifiable rebuild scratch directories.
func (d *DerivedStore) cleanupRebuildScratch(ctx context.Context) error {
	entries, err := d.fs.ReadDir(d.paths.RRDDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}

		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() || len(entry.Name()) < len(rebuildScratchPrefix) {
			continue
		}

		if entry.Name()[:len(rebuildScratchPrefix)] != rebuildScratchPrefix {
			continue
		}

		if err := d.fs.Remove(filepath.Join(d.paths.RRDDir, entry.Name(), "data.rrd")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}

		if err := d.fs.Remove(filepath.Join(d.paths.RRDDir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}

	if err := d.fs.SyncDir(d.paths.RRDDir); err != nil {
		return err
	}

	return ctx.Err()
}

func sortSeries(series []uint16) {
	for i := 1; i < len(series); i++ {
		for j := i; j > 0 && series[j] < series[j-1]; j-- {
			series[j], series[j-1] = series[j-1], series[j]
		}
	}
}

func latestSlot(records []journal.Record) int64 {
	var latest int64

	for _, record := range records {
		if record.Kind != journal.KindSample {
			continue
		}

		sample, err := journal.DecodeSample(record)
		if err != nil {
			continue
		}

		if sample.ElapsedMs > latest {
			latest = sample.ElapsedMs
		}
	}

	return latest
}

var _ = fmt.Sprintf
