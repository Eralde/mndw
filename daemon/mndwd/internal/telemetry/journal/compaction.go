package journal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// compactionTempPrefix marks rewrite temporaries so startup recovery can remove
// only identifiable orphans.
const compactionTempPrefix = ".compact-"

// compactSegmentLocked rewrites a partially live closed segment into a
// replacement file, preserving every retained sequence identity. It returns
// false when the segment holds no live records or cannot be compacted.
func (s *Storage) compactSegmentLocked(ctx context.Context, entry SegmentEntry, scan *retentionScan) (bool, error) {
	size := scan.bytes[entry.Name]
	if size == 0 {
		return false, nil
	}
	if size > s.limits.ScratchBytes {
		return false, fmt.Errorf("%w: segment %s exceeds scratch allowance", ErrPinPressure, entry.Name)
	}
	if s.scratchBytes+size > s.limits.ScratchBytes {
		return false, nil
	}

	live, err := s.liveRecordsLocked(entry, scan)
	if err != nil {
		return false, err
	}
	if len(live) == 0 {
		return false, nil
	}

	temp := filepath.Join(s.paths.JournalDir, compactionTempPrefix+entry.Name)
	file, err := s.fs.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return false, err
	}
	s.scratchBytes += size

	header, err := EncodeHeader(Header{
		Boot:          scan.bootOfSegment[entry.Name],
		SegmentID:     entry.SegmentID,
		BootOrder:     entry.BootOrder,
		FirstSequence: entry.FirstSequence,
	})
	if err != nil {
		_ = file.Close()
		s.scratchBytes -= size
		return false, err
	}
	if _, err := file.Write(header); err != nil {
		_ = file.Close()
		s.scratchBytes -= size
		return false, err
	}
	written := int64(len(header))
	for _, record := range live {
		encoded, err := EncodeRecord(record)
		if err != nil {
			_ = file.Close()
			s.scratchBytes -= size
			return false, err
		}
		n, err := file.Write(encoded)
		if err != nil {
			_ = file.Close()
			s.scratchBytes -= size
			return false, err
		}
		written += int64(n)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		s.scratchBytes -= size
		return false, err
	}
	if err := file.Close(); err != nil {
		s.scratchBytes -= size
		return false, err
	}

	if err := s.fs.Rename(temp, filepath.Join(s.paths.JournalDir, entry.Name)); err != nil {
		s.scratchBytes -= size
		return false, err
	}
	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		s.scratchBytes -= size
		return false, err
	}
	s.scratchBytes -= size

	for i := range s.manifest.Segments {
		if s.manifest.Segments[i].Name == entry.Name {
			s.manifest.Segments[i].Bytes = written
		}
	}
	s.manifestDirty = true
	if err := s.publishInventoryLocked(); err != nil {
		return true, err
	}
	return true, ctx.Err()
}

// liveRecordsLocked returns the records of one segment that retention must
// keep, preserving their on-disk sequence identities.
func (s *Storage) liveRecordsLocked(entry SegmentEntry, scan *retentionScan) ([]Record, error) {
	anchors := map[BootID]Anchor{}
	var live []Record

	err := scanSegmentFile(s.fs, filepath.Join(s.paths.JournalDir, entry.Name), 0, func(record Record) error {
		switch record.Kind {
		case KindSample:
			sample, err := DecodeSample(record)
			if err != nil {
				return nil
			}
			mapped := mappedUTC(sample, anchors)
			if expiredSample(sample, mapped, s.retention, s.limits.Retention) {
				return nil
			}
		case KindAnchor:
			// Anchors and publication decisions are retained for surviving
			// samples even when their own segment is partially live.
			if anchor, err := DecodeAnchor(record); err == nil {
				anchors[anchor.Boot] = anchor
			}
		}
		live = append(live, record)
		return nil
	})
	if err != nil {
		return nil, err
	}
	_ = scan
	return live, nil
}

// cleanupCompactionTemps removes identifiable orphaned rewrite temporaries.
// Only files carrying the compaction prefix are touched.
func (s *Storage) cleanupCompactionTemps(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.fs.ReadDir(s.paths.JournalDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || len(entry.Name()) == 0 || entry.Name()[0] != '.' {
			continue
		}
		if len(entry.Name()) < len(compactionTempPrefix) || entry.Name()[:len(compactionTempPrefix)] != compactionTempPrefix {
			continue
		}
		if err := s.fs.Remove(filepath.Join(s.paths.JournalDir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		return err
	}
	return ctx.Err()
}
