package journal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ErrPinPressure reports that retention cannot reclaim space without breaking a
// live pin. The caller must cancel or relinquish the rebuild lease first.
var ErrPinPressure = errors.New("journal: retention blocked by pinned inputs")

// RetentionInput supplies the trusted time and per-boot elapsed progress used
// to expire records. An untrusted wall clock is never used for expiry.
type RetentionInput struct {
	TrustedNowMs  *int64
	LatestElapsed map[BootID]int64
}

// MaintenanceResult describes changes made to the validated journal inventory.
type MaintenanceResult struct {
	InventoryChanged bool
}

// Lease pins the current inventory and the inputs referenced by a rebuild so
// retention cannot evict them mid-operation.
type Lease struct {
	storage    *Storage
	through    uint64
	generation uint64
	released   bool
}

// Close releases the pin.
func (l *Lease) Close() error {
	if l == nil || l.storage == nil || l.released {
		return nil
	}

	l.storage.mu.Lock()

	defer l.storage.mu.Unlock()

	l.released = true

	if l.storage.pins > 0 {
		l.storage.pins--
	}

	return nil
}

// Pin pins records up to the given sequence against eviction.
func (s *Storage) Pin(through uint64) (*Lease, error) {
	s.mu.Lock()

	defer s.mu.Unlock()

	if s.closed {
		return nil, errors.New("journal: storage is closed")
	}

	s.pins++

	return &Lease{storage: s, through: through, generation: s.manifest.Generation}, nil
}

// Maintain enforces age, session-count, and budget limits. Delivery progress
// never makes a record reclaimable, and no untrusted wall clock is used.
func (s *Storage) Maintain(ctx context.Context, input RetentionInput) (MaintenanceResult, error) {
	var result MaintenanceResult

	s.mu.Lock()

	defer s.mu.Unlock()

	if s.closed {
		return result, errors.New("journal: storage is closed")
	}

	s.retention = input

	live, _, err := s.scanRetentionLocked()
	if err != nil {
		return result, err
	}

	// Remove expired samples while preserving canonical anchors still used by
	// samples in other segments.
	for _, entry := range append([]SegmentEntry(nil), s.manifest.Segments...) {
		if s.isActiveLocked(entry) {
			continue
		}

		if !live.expiredSegments[entry.Name] {
			continue
		}

		if s.isPinnedLocked(live, entry) {
			return result, ErrPinPressure
		}

		if live.anchorNeededSegments[entry.Name] {
			compacted, err := s.compactSegmentLocked(ctx, entry, live)
			result.InventoryChanged = result.InventoryChanged || compacted

			if err != nil {
				return result, err
			}

			if !compacted {
				continue
			}

			live, _, err = s.scanRetentionLocked()
			if err != nil {
				return result, err
			}

			continue
		}

		changed, err := s.dropSegmentLocked(ctx, entry, live.sampleCounts[entry.Name], LossAge)
		result.InventoryChanged = result.InventoryChanged || changed

		if err != nil {
			return result, err
		}

		live, _, err = s.scanRetentionLocked()
		if err != nil {
			return result, err
		}
	}

	// Session-count overflow evicts the oldest boot.
	if err := s.enforceSessionLimitLocked(ctx, live, &result); err != nil {
		return result, err
	}

	live, _, err = s.scanRetentionLocked()
	if err != nil {
		return result, err
	}

	// Budget eviction removes oldest acquisition order first, compacting a
	// partially live segment before dropping it. The pass is bounded by the
	// segment count so a segment that cannot shrink is dropped instead.
	total := s.totalBytesLocked(live)

	for pass := 0; total > s.limits.Bytes && pass <= len(s.manifest.Segments); pass++ {
		entry := s.oldestSegmentLocked(live)

		if entry.Name == "" || s.isActiveLocked(entry) {
			break
		}

		if live.anchorNeededSegments[entry.Name] {
			boot := live.sessionOfSegment[entry.Name]

			if boot == "" || boot == s.activeBootLocked() {
				break
			}

			changed, err := s.dropSessionLocked(ctx, live, boot, LossBudget)
			result.InventoryChanged = result.InventoryChanged || changed

			if err != nil {
				return result, err
			}

			refreshed, _, err := s.scanRetentionLocked()
			if err != nil {
				return result, err
			}

			live = refreshed
			total = s.totalBytesLocked(live)

			continue
		}

		if s.isPinnedLocked(live, entry) {
			return result, ErrPinPressure
		}

		before := total
		compacted, err := s.compactSegmentLocked(ctx, entry, live)
		result.InventoryChanged = result.InventoryChanged || compacted

		if err != nil {
			return result, err
		}

		if compacted {
			refreshed, _, err := s.scanRetentionLocked()
			if err != nil {
				return result, err
			}

			live = refreshed
			total = s.totalBytesLocked(live)

			if total < before {
				continue
			}
		}

		changed, err := s.dropSegmentLocked(ctx, entry, live.sampleCounts[entry.Name], LossBudget)
		result.InventoryChanged = result.InventoryChanged || changed

		if err != nil {
			return result, err
		}

		refreshed, _, err := s.scanRetentionLocked()
		if err != nil {
			return result, err
		}

		live = refreshed
		total = s.totalBytesLocked(live)
	}

	if s.limits.Sessions > 0 && len(live.sessions) > s.limits.Sessions {
		if err := s.enforceSessionLimitLocked(ctx, live, &result); err != nil {
			return result, err
		}
	}

	return result, nil
}

// Coverage reports the reconstructable extent of each retained series. Bounds
// are outer extents, not a claim of continuous data.
func (s *Storage) Coverage() []Coverage {
	lease, err := s.Pin(s.DurableThrough())
	if err != nil {
		return nil
	}

	defer lease.Close()

	s.mu.Lock()

	paths := s.paths
	fs := s.fs
	segments := append([]SegmentEntry(nil), s.manifest.Segments...)

	s.mu.Unlock()

	var records []Record

	for _, entry := range segments {
		_ = scanSegmentFile(fs, filepath.Join(paths.JournalDir, entry.Name), 0, func(record Record) error {
			records = append(records, record)

			return nil
		})
	}

	anchors := BuildAnchorIndex(records)
	bySeries := map[uint16]*Coverage{}
	unanchored := map[uint16]bool{}
	uncertain := map[uint16]bool{}

	for _, record := range records {
		if record.Kind != KindSample {
			continue
		}

		sample, err := DecodeSample(record)
		if err != nil {
			continue
		}

		coverage, ok := bySeries[sample.Series]

		if !ok {
			coverage = &Coverage{Series: sample.Series}
			bySeries[sample.Series] = coverage
		}

		anchor, ok := anchors.AnchorFor(sample)

		if !ok {
			unanchored[sample.Series] = true

			continue
		}

		utc, err := MapUTC(anchor, sample.ElapsedMs)
		if err != nil {
			uncertain[sample.Series] = true

			continue
		}

		if coverage.StartMs == nil || utc < *coverage.StartMs {
			start := utc
			coverage.StartMs = &start
		}

		if coverage.EndMs == nil || utc > *coverage.EndMs {
			end := utc
			coverage.EndMs = &end
		}
	}

	result := make([]Coverage, 0, len(bySeries))

	for series, coverage := range bySeries {
		if unanchored[series] {
			coverage.Reasons = append(coverage.Reasons, ReasonUnanchored)
		}

		if uncertain[series] {
			coverage.Reasons = append(coverage.Reasons, ReasonUncertain)
		}

		coverage.Complete = coverage.StartMs != nil && coverage.EndMs != nil && len(coverage.Reasons) == 0
		coverage.EdgeComplete = coverage.Complete

		if len(segments) == 0 {
			coverage.Reasons = append(coverage.Reasons, ReasonMissing)
		}

		result = append(result, *coverage)
	}

	sort.Slice(result, func(i, j int) bool { return result[i].Series < result[j].Series })

	return result
}

// expiredSample reports whether a sample is older than the retention window.
// A dated record requires trustworthy now; an unknown-time record is aged only
// against its own boot's latest elapsed value.
func expiredSample(sample Sample, mappedUTC *int64, input RetentionInput, keep time.Duration) bool {
	return SampleExpired(sample, mappedUTC, input, keep)
}

// retentionScan is the per-segment liveness result of one retention pass.
type retentionScan struct {
	expiredSegments       map[string]bool
	sampleCounts          map[string]int
	sessions              []string
	sessionOfSegment      map[string]string
	bytes                 map[string]int64
	order                 map[string]uint64
	records               map[string][]Record
	expiredSamples        map[uint64]bool
	canonicalAnchors      map[uint64]bool
	anchorNeededSegments  map[string]bool
	expiredSampleSegments map[string]bool
}

func (s *Storage) scanRetentionLocked() (*retentionScan, map[string]bool, error) {
	scan := &retentionScan{
		expiredSegments:       map[string]bool{},
		sampleCounts:          map[string]int{},
		sessionOfSegment:      map[string]string{},
		bytes:                 map[string]int64{},
		order:                 map[string]uint64{},
		records:               map[string][]Record{},
		expiredSamples:        map[uint64]bool{},
		canonicalAnchors:      map[uint64]bool{},
		anchorNeededSegments:  map[string]bool{},
		expiredSampleSegments: map[string]bool{},
	}
	expired := map[string]bool{}
	sessionFirstSequence := map[string]uint64{}
	var allRecords []Record

	for _, entry := range s.manifest.Segments {
		scan.sessionOfSegment[entry.Name] = entry.Boot

		if first, ok := sessionFirstSequence[entry.Boot]; !ok || entry.FirstSequence < first {
			sessionFirstSequence[entry.Boot] = entry.FirstSequence
		}

		raw, err := s.fs.ReadFile(filepath.Join(s.paths.JournalDir, entry.Name))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}

			return nil, nil, err
		}

		scan.bytes[entry.Name] = int64(len(raw))
		scan.order[entry.Name] = entry.FirstSequence

		if err := scanSegmentFile(s.fs, filepath.Join(s.paths.JournalDir, entry.Name), 0, func(record Record) error {
			scan.records[entry.Name] = append(scan.records[entry.Name], record)
			allRecords = append(allRecords, record)

			return nil
		}); err != nil {
			return nil, nil, err
		}
	}

	for boot := range sessionFirstSequence {
		scan.sessions = append(scan.sessions, boot)
	}

	sort.Slice(scan.sessions, func(i, j int) bool {
		left := sessionFirstSequence[scan.sessions[i]]
		right := sessionFirstSequence[scan.sessions[j]]

		if left == right {
			return scan.sessions[i] < scan.sessions[j]
		}

		return left < right
	})

	index := BuildAnchorIndex(allRecords)

	for _, entry := range s.manifest.Segments {
		allExpired := true
		anySample := false

		for _, record := range scan.records[entry.Name] {
			if record.Kind != KindSample {
				continue
			}

			sample, err := DecodeSample(record)
			if err != nil {
				continue
			}

			scan.sampleCounts[entry.Name]++
			anySample = true
			var mapped *int64

			if anchor, ok := index.AnchorFor(sample); ok {
				if utc, err := MapUTC(anchor, sample.ElapsedMs); err == nil {
					mapped = &utc

					if !expiredSample(sample, mapped, s.retention, s.limits.Retention) {
						scan.canonicalAnchors[anchor.Seq] = true
					}
				}
			}

			isExpired := expiredSample(sample, mapped, s.retention, s.limits.Retention)
			scan.expiredSamples[record.Seq] = isExpired

			if isExpired {
				scan.expiredSampleSegments[entry.Name] = true
			} else {
				allExpired = false
			}
		}

		if anySample && allExpired {
			scan.expiredSegments[entry.Name] = true
		}

		expired[entry.Name] = scan.expiredSegments[entry.Name]
	}

	for _, entry := range s.manifest.Segments {
		for _, record := range scan.records[entry.Name] {
			if record.Kind == KindAnchor && scan.canonicalAnchors[record.Seq] {
				scan.anchorNeededSegments[entry.Name] = true
			}
		}
	}

	return scan, expired, nil
}

// totalBytesLocked sums every committed segment including temporary files.
func (s *Storage) totalBytesLocked(scan *retentionScan) int64 {
	var total int64

	for _, entry := range s.manifest.Segments {
		if size, ok := scan.bytes[entry.Name]; ok {
			total += size

			continue
		}

		total += entry.Bytes
	}

	return total + s.scratchBytes
}

// oldestSegmentLocked returns the segment with the lowest acquisition order.
func (s *Storage) oldestSegmentLocked(scan *retentionScan) SegmentEntry {
	var oldest SegmentEntry
	var active SegmentEntry

	for _, entry := range s.manifest.Segments {
		if s.isActiveLocked(entry) {
			active = entry

			continue
		}

		if oldest.Name == "" || entry.FirstSequence < oldest.FirstSequence {
			oldest = entry
		}
	}

	if oldest.Name == "" {
		oldest = active
	}

	_ = scan

	return oldest
}

// isActiveLocked reports whether entry names the writer's currently open inode.
func (s *Storage) isActiveLocked(entry SegmentEntry) bool {
	return s.active != nil && !s.active.sealed && entry.Name == s.active.name
}

// activeBootLocked returns the boot of the writer's open segment, if any.
func (s *Storage) activeBootLocked() string {
	if s.active == nil || s.active.sealed {
		return ""
	}

	return s.active.boot.String()
}

// isPinnedLocked reports whether evicting this segment would break a live pin.
func (s *Storage) isPinnedLocked(scan *retentionScan, entry SegmentEntry) bool {
	if s.pins == 0 {
		return false
	}

	// Every pinned rebuild streams the whole retained prefix, so any eviction
	// while a pin is held is pressure rather than progress.
	_ = scan
	_ = entry

	return true
}

// dropSegmentLocked removes one segment and records a loss counter for the
// samples it contained.
func (s *Storage) dropSegmentLocked(ctx context.Context, entry SegmentEntry, samples int, reason LossReason) (bool, error) {
	if samples > 0 {
		if err := s.recordLossLocked(reason, uint64(samples)); err != nil {
			return false, err
		}
	}

	if err := s.fs.Remove(filepath.Join(s.paths.JournalDir, entry.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}

	changed := true

	segments := make([]SegmentEntry, 0, len(s.manifest.Segments))

	for _, existing := range s.manifest.Segments {
		if existing.Name == entry.Name {
			continue
		}

		segments = append(segments, existing)
	}

	s.manifest.Segments = segments
	s.manifestDirty = true

	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		return changed, err
	}

	if err := s.publishInventoryLocked(); err != nil {
		return changed, err
	}

	return changed, ctx.Err()
}

// recordLossLocked appends a loss diagnostic through the current writer or
// defers it until a valid boot owner is available.
func (s *Storage) recordLossLocked(reason LossReason, count uint64) error {
	if count == 0 {
		return nil
	}

	prepared, err := PrepareLoss(Loss{Reason: reason, Count: count})
	if err != nil {
		return err
	}

	if s.active != nil && !s.active.sealed {
		_, err := s.appendReservedLocked(prepared)

		return err
	}

	if s.pendingLoss == nil {
		s.pendingLoss = map[LossReason]uint64{}
	}

	previous := s.pendingLoss[reason]

	if count > maxUint64-previous {
		return errors.New("journal: pending loss count overflow")
	}

	s.pendingLoss[reason] = previous + count

	return nil
}

// enforceSessionLimitLocked evicts the oldest boot until the session limit
// holds.
func (s *Storage) enforceSessionLimitLocked(ctx context.Context, scan *retentionScan, result *MaintenanceResult) error {
	if s.limits.Sessions <= 0 || len(scan.sessions) <= s.limits.Sessions {
		return nil
	}

	for len(scan.sessions) > s.limits.Sessions {
		activeBoot := s.activeBootLocked()
		oldest := ""

		for _, boot := range scan.sessions {
			if boot != activeBoot {
				oldest = boot

				break
			}
		}

		if oldest == "" {
			break
		}

		changed, err := s.dropSessionLocked(ctx, scan, oldest, LossSessionLimit)
		result.InventoryChanged = result.InventoryChanged || changed

		if err != nil {
			return err
		}

		refreshed, _, err := s.scanRetentionLocked()
		if err != nil {
			return err
		}

		scan = refreshed
	}

	return nil
}

// dropSessionLocked evicts every non-active segment owned by one boot, oldest first.
func (s *Storage) dropSessionLocked(ctx context.Context, scan *retentionScan, boot string, reason LossReason) (bool, error) {
	entries := append([]SegmentEntry(nil), s.manifest.Segments...)

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].FirstSequence < entries[j].FirstSequence
	})

	var changed bool

	for _, entry := range entries {
		if scan.sessionOfSegment[entry.Name] != boot || s.isActiveLocked(entry) {
			continue
		}

		if s.isPinnedLocked(scan, entry) {
			return changed, ErrPinPressure
		}

		dropped, err := s.dropSegmentLocked(ctx, entry, scan.sampleCounts[entry.Name], reason)
		changed = changed || dropped

		if err != nil {
			return changed, err
		}
	}

	return changed, nil
}

// appendReservedLocked appends a metadata record using the current reservation
// without disturbing the active sample segment.
func (s *Storage) appendReservedLocked(prepared Record) (AppendResult, error) {
	if err := s.reserveLocked(); err != nil {
		return AppendResult{}, err
	}

	sequence := s.nextSequence
	encoded, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: sequence, Payload: prepared.Payload})
	if err != nil {
		return AppendResult{}, err
	}

	if err := s.ensureSegmentLocked(s.activeBoot); err != nil {
		return AppendResult{}, err
	}

	if _, err := s.active.file.Write(encoded); err != nil {
		s.needsRepair = true

		return AppendResult{NeedsRepair: true}, err
	}

	s.active.size += int64(len(encoded))
	s.nextSequence = sequence + 1
	s.lastSequence = sequence
	s.manifestDirty = true

	if err := s.publishInventoryLocked(); err != nil {
		return AppendResult{NeedsRepair: true}, err
	}

	return AppendResult{Accepted: 1, FirstSequence: sequence, LastSequence: sequence}, nil
}

// String renders a retention summary for diagnostics.
func (r RetentionInput) String() string {
	return fmt.Sprintf("RetentionInput{trusted=%v boots=%d}", r.TrustedNowMs != nil, len(r.LatestElapsed))
}
