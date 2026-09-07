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
func (s *Storage) Maintain(ctx context.Context, input RetentionInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return errors.New("journal: storage is closed")
	}
	s.retention = input

	live, _, err := s.scanRetentionLocked()
	if err != nil {
		return err
	}

	// Reclaim fully expired closed segments without copying them.
	for _, entry := range s.manifest.Segments {
		if !entry.Sealed {
			continue
		}
		if !live.expiredSegments[entry.Name] {
			continue
		}
		if s.isPinnedLocked(live, entry) {
			return ErrPinPressure
		}
		if err := s.dropSegmentLocked(ctx, entry, live.sampleCounts[entry.Name], LossAge); err != nil {
			return err
		}
	}

	// Session-count overflow evicts the oldest boot.
	if err := s.enforceSessionLimitLocked(ctx, live); err != nil {
		return err
	}

	// Budget eviction removes oldest acquisition order first, compacting a
	// partially live segment before dropping it. The pass is bounded by the
	// segment count so a segment that cannot shrink is dropped instead.
	total := s.totalBytesLocked(live)
	for pass := 0; total > s.limits.Bytes && pass <= len(s.manifest.Segments); pass++ {
		entry := s.oldestSegmentLocked(live)
		if entry.Name == "" {
			break
		}
		if s.isPinnedLocked(live, entry) {
			return ErrPinPressure
		}
		if !entry.Sealed {
			// Keep the active inode appendable. It will be considered on the
			// next pass after rollover; deleting it would leave the writer
			// pointing at an unlisted file.
			break
		}

		before := total
		compacted, err := s.compactSegmentLocked(ctx, entry, live)
		if err != nil {
			return err
		}
		if compacted {
			refreshed, _, err := s.scanRetentionLocked()
			if err != nil {
				return err
			}
			live = refreshed
			total = s.totalBytesLocked(live)
			if total < before {
				continue
			}
		}
		if err := s.dropSegmentLocked(ctx, entry, live.sampleCounts[entry.Name], LossBudget); err != nil {
			return err
		}
		refreshed, _, err := s.scanRetentionLocked()
		if err != nil {
			return err
		}
		live = refreshed
		total = s.totalBytesLocked(live)
	}

	if s.limits.Sessions > 0 && len(live.boots) > s.limits.Sessions {
		return s.enforceSessionLimitLocked(ctx, live)
	}
	return nil
}

// Coverage reports the reconstructable extent of each retained series. Bounds
// are outer extents, not a claim of continuous data.
func (s *Storage) Coverage() []Coverage {
	s.mu.Lock()
	paths := s.paths
	fs := s.fs
	segments := append([]SegmentEntry(nil), s.manifest.Segments...)
	limits := s.limits
	s.mu.Unlock()

	anchors := map[BootID]Anchor{}
	bySeries := map[uint16]*Coverage{}
	unanchored := map[uint16]bool{}

	visit := func(record Record) error {
		switch record.Kind {
		case KindAnchor:
			if anchor, err := DecodeAnchor(record); err == nil {
				if existing, ok := anchors[anchor.Boot]; !ok || anchor.Seq >= existing.Seq {
					anchors[anchor.Boot] = anchor
				}
			}
		case KindSample:
			sample, err := DecodeSample(record)
			if err != nil {
				return nil
			}
			coverage, ok := bySeries[sample.Series]
			if !ok {
				coverage = &Coverage{Series: sample.Series}
				bySeries[sample.Series] = coverage
			}
			anchor, ok := anchors[sample.Boot]
			if !ok {
				unanchored[sample.Series] = true
				return nil
			}
			utc := anchor.UTCMs + sample.ElapsedMs - anchor.ElapsedMs
			if coverage.StartMs == nil || utc < *coverage.StartMs {
				start := utc
				coverage.StartMs = &start
			}
			if coverage.EndMs == nil || utc > *coverage.EndMs {
				end := utc
				coverage.EndMs = &end
			}
		}
		return nil
	}

	for _, entry := range segments {
		_ = scanSegmentFile(fs, filepath.Join(paths.JournalDir, entry.Name), 0, visit)
	}

	result := make([]Coverage, 0, len(bySeries))
	for series, coverage := range bySeries {
		if unanchored[series] {
			coverage.Reasons = append(coverage.Reasons, ReasonUnanchored)
		}
		coverage.Complete = coverage.StartMs != nil && coverage.EndMs != nil && len(coverage.Reasons) == 0
		coverage.EdgeComplete = coverage.Complete
		if len(segments) == 0 {
			coverage.Reasons = append(coverage.Reasons, ReasonMissing)
		}
		result = append(result, *coverage)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Series < result[j].Series })
	_ = limits
	return result
}

// expiredSample reports whether a sample is older than the retention window.
// A dated record requires trustworthy now; an unknown-time record is aged only
// against its own boot's latest elapsed value.
func expiredSample(sample Sample, mappedUTC *int64, input RetentionInput, keep time.Duration) bool {
	if keep <= 0 {
		return false
	}
	if mappedUTC != nil {
		if input.TrustedNowMs == nil {
			return false
		}
		return *input.TrustedNowMs-*mappedUTC > keep.Milliseconds()
	}
	latest, ok := input.LatestElapsed[sample.Boot]
	if !ok {
		return false
	}
	return latest-sample.ElapsedMs > keep.Milliseconds()
}

// retentionScan is the per-segment liveness result of one retention pass.
type retentionScan struct {
	expiredSegments map[string]bool
	sampleCounts    map[string]int
	boots           []BootID
	bootOfSegment   map[string]BootID
	bytes           map[string]int64
	order           map[string]uint64
}

func (s *Storage) scanRetentionLocked() (*retentionScan, map[string]bool, error) {
	scan := &retentionScan{
		expiredSegments: map[string]bool{},
		sampleCounts:    map[string]int{},
		bootOfSegment:   map[string]BootID{},
		bytes:           map[string]int64{},
		order:           map[string]uint64{},
	}
	expired := map[string]bool{}
	bootSeen := map[BootID]bool{}
	anchors := map[BootID]Anchor{}

	for _, entry := range s.manifest.Segments {
		raw, err := s.fs.ReadFile(filepath.Join(s.paths.JournalDir, entry.Name))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, nil, err
		}
		scan.bytes[entry.Name] = int64(len(raw))
		scan.order[entry.Name] = entry.FirstSequence

		samples := 0
		allExpired := true
		anySample := false
		_ = scanSegmentFile(s.fs, filepath.Join(s.paths.JournalDir, entry.Name), 0, func(record Record) error {
			switch record.Kind {
			case KindBootStart:
				if bootStart, err := DecodeBootStart(record); err == nil {
					scan.bootOfSegment[entry.Name] = bootStart.Boot
					if !bootSeen[bootStart.Boot] {
						bootSeen[bootStart.Boot] = true
						scan.boots = append(scan.boots, bootStart.Boot)
					}
				}
			case KindAnchor:
				if anchor, err := DecodeAnchor(record); err == nil {
					if existing, ok := anchors[anchor.Boot]; !ok || anchor.Seq >= existing.Seq {
						anchors[anchor.Boot] = anchor
					}
				}
			case KindSample:
				sample, err := DecodeSample(record)
				if err != nil {
					return nil
				}
				samples++
				anySample = true
				mapped := mappedUTC(sample, anchors)
				if !expiredSample(sample, mapped, s.retention, s.limits.Retention) {
					allExpired = false
				}
			}
			return nil
		})
		scan.sampleCounts[entry.Name] = samples
		if anySample && allExpired {
			scan.expiredSegments[entry.Name] = true
		}
		expired[entry.Name] = scan.expiredSegments[entry.Name]
	}
	return scan, expired, nil
}

// mappedUTC returns the mapped calendar time when the sample's boot has an
// anchor, and nil otherwise.
func mappedUTC(sample Sample, anchors map[BootID]Anchor) *int64 {
	anchor, ok := anchors[sample.Boot]
	if !ok {
		return nil
	}
	utc := anchor.UTCMs + sample.ElapsedMs - anchor.ElapsedMs
	return &utc
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
		if !entry.Sealed {
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
func (s *Storage) dropSegmentLocked(ctx context.Context, entry SegmentEntry, samples int, reason LossReason) error {
	if samples > 0 {
		prepared, err := PrepareLoss(Loss{Reason: reason, Count: uint64(samples)})
		if err != nil {
			return err
		}
		previousActive := s.active
		s.active = nil
		if _, err := s.appendReservedLocked(prepared); err != nil {
			s.active = previousActive
			return err
		}
		s.active = previousActive
	}

	if err := s.fs.Remove(filepath.Join(s.paths.JournalDir, entry.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		return err
	}

	segments := make([]SegmentEntry, 0, len(s.manifest.Segments))
	for _, existing := range s.manifest.Segments {
		if existing.Name == entry.Name {
			continue
		}
		segments = append(segments, existing)
	}
	s.manifest.Segments = segments
	s.manifestDirty = true
	if err := s.publishInventoryLocked(); err != nil {
		return err
	}
	return ctx.Err()
}

// enforceSessionLimitLocked evicts the oldest boot until the session limit
// holds.
func (s *Storage) enforceSessionLimitLocked(ctx context.Context, scan *retentionScan) error {
	if s.limits.Sessions <= 0 || len(scan.boots) <= s.limits.Sessions {
		return nil
	}
	excess := len(scan.boots) - s.limits.Sessions
	for i := 0; i < excess; i++ {
		oldest := scan.boots[i]
		for _, entry := range append([]SegmentEntry(nil), s.manifest.Segments...) {
			if scan.bootOfSegment[entry.Name] != oldest {
				continue
			}
			if s.isPinnedLocked(scan, entry) {
				return ErrPinPressure
			}
			if err := s.dropSegmentLocked(ctx, entry, scan.sampleCounts[entry.Name], LossSessionLimit); err != nil {
				return err
			}
		}
	}
	return nil
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
