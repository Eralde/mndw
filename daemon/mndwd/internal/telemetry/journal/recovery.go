package journal

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// quarantinePrefix marks a segment whose interior damage prevents validated
// replay. Quarantined files are retained for diagnosis and counted toward the
// storage budget.
const quarantinePrefix = ".damaged-"

// recoverInventory validates every committed segment, quarantines interior
// corruption, and returns the highest validated sequence together with any
// issues. It never scans arbitrary bytes as though they were record
// boundaries.
func recoverInventory(fs FileSystem, paths StoragePaths, manifest *Manifest) (uint64, []RecoveryIssue, error) {
	var (
		lastSequence uint64
		issues       []RecoveryIssue
		kept         []SegmentEntry
	)

	for _, entry := range manifest.Segments {
		path := filepath.Join(paths.JournalDir, entry.Name)
		raw, err := fs.ReadFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				issues = append(issues, RecoveryIssue{Code: issueSegmentDamaged})

				continue
			}

			return lastSequence, nil, err
		}

		validBytes, highest, damaged := scanBytes(raw)

		if damaged {
			firstSequence := entry.FirstSequence
			last := highest
			issues = append(issues, RecoveryIssue{Code: issueSegmentDamaged, FirstSequence: &firstSequence, LastSequence: &last})

			if err := quarantineSegment(fs, paths, entry.Name); err != nil {
				return lastSequence, nil, err
			}

			continue
		}

		if highest > lastSequence {
			lastSequence = highest
		}

		// A torn final frame is not interior corruption. Remove it before the
		// segment is reopened so new records cannot be appended behind bytes
		// that make every subsequent scan stop early.
		if validBytes < int64(len(raw)) {
			file, openErr := fs.OpenFile(path, os.O_WRONLY, 0o644)

			if openErr != nil {
				return lastSequence, nil, openErr
			}

			if truncateErr := file.Truncate(validBytes); truncateErr != nil {
				_ = file.Close()

				return lastSequence, nil, truncateErr
			}

			if syncErr := file.Sync(); syncErr != nil {
				_ = file.Close()

				return lastSequence, nil, syncErr
			}

			if closeErr := file.Close(); closeErr != nil {
				return lastSequence, nil, closeErr
			}
		}

		// Sync every recovered segment, including sealed segments. There is no
		// active writer yet during recovery, so Storage.Sync alone cannot flush
		// these files.
		file, openErr := fs.OpenFile(path, os.O_WRONLY, 0o644)

		if openErr != nil {
			return lastSequence, nil, openErr
		}

		syncErr := file.Sync()
		closeErr := file.Close()

		if syncErr != nil {
			return lastSequence, nil, syncErr
		}

		if closeErr != nil {
			return lastSequence, nil, closeErr
		}

		entry.Bytes = validBytes
		kept = append(kept, entry)
	}

	manifest.Segments = kept

	return lastSequence, issues, nil
}

// quarantineSegment renames a damaged segment out of the inventory without
// deleting evidence.
func quarantineSegment(fs FileSystem, paths StoragePaths, name string) error {
	target, err := quarantineTarget(fs, paths.JournalDir, name)
	if err != nil {
		return err
	}

	if err := fs.Rename(filepath.Join(paths.JournalDir, name), target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}

		return err
	}

	return fs.SyncDir(paths.JournalDir)
}

// quarantineTarget returns the first unused evidence filename for a damaged segment.
func quarantineTarget(fs FileSystem, dir, name string) (string, error) {
	base := filepath.Join(dir, quarantinePrefix+name)

	for suffix := 1; ; suffix++ {
		candidate := base

		if suffix > 1 {
			candidate = fmt.Sprintf("%s.%d", base, suffix)
		}

		_, err := fs.Stat(candidate)
		if err == nil {
			continue
		}

		if errors.Is(err, os.ErrNotExist) {
			return candidate, nil
		}

		return "", err
	}
}

// scanBytes returns the highest sequence of complete validated frames, whether
// the segment contains damage beyond a truncated tail, and the byte length of
// the validated prefix.
func scanBytes(raw []byte) (validBytes int64, highest uint64, damaged bool) {
	if len(raw) == 0 {
		return 0, 0, false
	}

	if len(raw) < headerBytes {
		return 0, 0, true
	}

	if _, err := DecodeHeader(bytes.NewReader(raw)); err != nil {
		return 0, 0, true
	}

	offset := int64(headerBytes)

	for {
		remaining := int64(len(raw)) - offset

		if remaining <= 0 {
			return offset, highest, false
		}

		if remaining < 4 {
			// A partial length prefix is a torn tail, not interior damage.
			return offset, highest, false
		}

		declared := int64(binary.LittleEndian.Uint32(raw[offset:]))

		if declared < minBodyBytes || declared > maxBodyBytes {
			// An implausible length is a torn tail only when the remaining bytes
			// are the short prefix or entirely zero padding.
			if remaining <= 4 || allZero(raw[offset:]) {
				return offset, highest, false
			}

			return offset, highest, true
		}

		end := offset + 4 + declared + 4

		if end > int64(len(raw)) {
			// The final frame is incomplete: earlier frames stay authoritative.
			return offset, highest, false
		}

		record, err := DecodeRecord(bytes.NewReader(raw[offset:end]))
		if err != nil {
			// A complete but invalid final frame may be a torn write. Any
			// non-zero bytes after it make the failure interior damage.
			if end == int64(len(raw)) || allZero(raw[end:]) {
				return offset, highest, false
			}

			return offset, highest, true
		}

		if record.Seq > highest {
			highest = record.Seq
		}

		offset = end
	}
}

// allZero reports whether every byte is zero. It is used to distinguish a
// zero-padded torn tail from damaged bytes followed by later journal data.
func allZero(raw []byte) bool {
	for _, value := range raw {
		if value != 0 {
			return false
		}
	}

	return true
}

// scanSegmentBytes validates one segment file and reports its validated prefix
// and highest sequence.
func scanSegmentBytes(fs FileSystem, path string) (int64, uint64, error) {
	raw, err := fs.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}

	validBytes, highest, damaged := scanBytes(raw)

	if damaged {
		return validBytes, highest, fmt.Errorf("%w: %s", ErrChecksum, filepath.Base(path))
	}

	return validBytes, highest, nil
}

// scanSegmentFile streams one segment file through a visitor, stopping at the
// given sequence or at the first incomplete frame.
func scanSegmentFile(fs FileSystem, path string, through uint64, visit func(Record) error) error {
	return scanSegmentFileAfter(fs, path, 0, through, visit)
}

// scanSegmentFileAfter validates one segment and visits records in
// (after, through]. A zero through means no upper sequence bound.
func scanSegmentFileAfter(fs FileSystem, path string, after, through uint64, visit func(Record) error) error {
	raw, err := fs.ReadFile(path)
	if err != nil {
		return err
	}

	if len(raw) == 0 {
		return nil
	}

	if _, err := DecodeHeader(bytes.NewReader(raw)); err != nil {
		return err
	}

	reader := bytes.NewReader(raw[headerBytes:])

	for {
		record, err := DecodeRecord(reader)
		if err != nil {
			if errors.Is(err, ErrTruncatedTail) || errors.Is(err, ErrChecksum) || errors.Is(err, ErrRecordLength) {
				return nil
			}

			return err
		}

		if record.Seq == 0 {
			return fmt.Errorf("%w: on-disk record has sequence zero", ErrSequence)
		}

		if through > 0 && record.Seq > through {
			return nil
		}

		if record.Seq <= after {
			continue
		}

		if err := visit(record); err != nil {
			return err
		}
	}
}

// recoverWritableStorage validates segments and promotes recovered frames with
// a single recovery sync. A failed sync leaves the frames retained but
// ineligible for publication.
func recoverWritableStorage(ctx context.Context, storage *Storage) ([]RecoveryIssue, error) {
	if err := storage.cleanupCompactionTemps(ctx); err != nil {
		return nil, err
	}

	storage.mu.Lock()

	lastSequence, issues, err := recoverInventory(storage.fs, storage.paths, &storage.manifest)
	if err != nil {
		storage.mu.Unlock()

		return nil, err
	}

	storage.nextSequence = storage.manifest.ReservedThrough + 1
	storage.lastSequence = lastSequence
	storage.manifestDirty = true

	storage.mu.Unlock()

	if lastSequence > 0 {
		if _, err := storage.Sync(ctx); err != nil {
			return append(issues, RecoveryIssue{Code: issueRecovered}), err
		}

		return issues, nil
	}

	if _, err := storage.Sync(ctx); err != nil {
		return issues, err
	}

	return issues, nil
}
