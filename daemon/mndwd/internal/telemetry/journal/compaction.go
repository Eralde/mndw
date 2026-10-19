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
	if s.isActiveLocked(entry) {
		return false, nil
	}

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

	source, err := s.fs.OpenFile(filepath.Join(s.paths.JournalDir, entry.Name), os.O_RDONLY, 0)
	if err != nil {
		return false, err
	}

	header, err := DecodeHeader(source)
	closeErr := source.Close()

	if err != nil {
		return false, err
	}

	if closeErr != nil {
		return false, closeErr
	}

	temp := filepath.Join(s.paths.JournalDir, compactionTempPrefix+entry.Name)
	file, err := s.fs.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return false, err
	}

	s.scratchBytes += size

	encodedHeader, err := EncodeHeader(Header{
		Boot:          header.Boot,
		SegmentID:     entry.SegmentID,
		BootOrder:     entry.BootOrder,
		FirstSequence: entry.FirstSequence,
	})
	if err != nil {
		_ = file.Close()
		s.scratchBytes -= size

		return false, err
	}

	if _, err := file.Write(encodedHeader); err != nil {
		_ = file.Close()
		s.scratchBytes -= size

		return false, err
	}

	written := int64(len(encodedHeader))

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

	for i := range s.manifest.Segments {
		if s.manifest.Segments[i].Name == entry.Name {
			s.manifest.Segments[i].Bytes = written
			s.manifest.Segments[i].Sealed = true
		}
	}

	s.manifestDirty = true

	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		s.scratchBytes -= size

		return true, err
	}

	s.scratchBytes -= size

	if err := s.publishInventoryLocked(); err != nil {
		return true, err
	}

	return true, ctx.Err()
}

// liveRecordsLocked returns the records of one segment that retention must
// keep, preserving their on-disk sequence identities.
func (s *Storage) liveRecordsLocked(entry SegmentEntry, scan *retentionScan) ([]Record, error) {
	var live []Record

	err := scanSegmentFile(s.fs, filepath.Join(s.paths.JournalDir, entry.Name), 0, func(record Record) error {
		switch record.Kind {
		case KindSample:
			if scan.expiredSamples[record.Seq] {
				return nil
			}
		case KindAnchor:
			// Keep only canonical anchors that still map at least one live sample,
			// including samples in later segments.
			if !scan.canonicalAnchors[record.Seq] {
				return nil
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
