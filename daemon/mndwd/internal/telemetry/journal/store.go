package journal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	// reservationBlock is the number of sequences reserved durably before use.
	reservationBlock = 1024
	// maxUint64 is the highest usable sequence; the ceiling is never allocated.
	maxUint64 = ^uint64(0)
)

// ErrNeedsRepair reports that a torn tail blocks further appends until
// RepairTail verifies or truncates it.
var ErrNeedsRepair = errors.New("journal: segment tail needs repair")

// openSegment is the writable segment file owned by a Storage.
type openSegment struct {
	name      string
	file      File
	boot      BootID
	segmentID uint64
	size      int64
	sealed    bool
}

// Append validates, allocates, and writes a batch of prepared records. It is
// prefix-accepting: on failure it reports the complete accepted prefix and
// marks the tail as needing repair.
func (s *Storage) Append(ctx context.Context, records []Record) (AppendResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return AppendResult{}, errors.New("journal: storage is closed")
	}
	if len(records) == 0 {
		return AppendResult{}, nil
	}
	if s.needsRepair {
		return AppendResult{}, ErrNeedsRepair
	}

	// Validate the whole batch before any sequence is allocated or written.
	for i, record := range records {
		if record.Seq != 0 {
			return AppendResult{}, fmt.Errorf("%w: record %d already carries sequence %d", ErrSequence, i, record.Seq)
		}
		if err := validateKindData(record); err != nil {
			return AppendResult{}, err
		}
	}

	if err := ctx.Err(); err != nil {
		return AppendResult{}, err
	}

	result := AppendResult{}
	for _, record := range records {
		if err := s.reserveLocked(); err != nil {
			return result, err
		}
		sequence := s.nextSequence
		if sequence == 0 || sequence > s.manifest.ReservedThrough {
			return result, errors.New("journal: sequence allocation outside reservation")
		}

		encoded, err := EncodeRecord(Record{Kind: record.Kind, Seq: sequence, Payload: record.Payload})
		if err != nil {
			return result, err
		}
		if record.Kind == KindBootStart {
			// The boot-start sequence is part of the segment header. Set it
			// before opening a new segment so the header and record agree.
			s.bootOrder = sequence
		}

		if err := s.ensureSegmentLocked(recordBoot(record, s.activeBoot)); err != nil {
			return result, err
		}
		segment := s.active
		if segment.size+int64(len(encoded)) > s.limits.SegmentBytes {
			if err := s.sealActiveLocked(); err != nil {
				return result, err
			}
			if err := s.ensureSegmentLocked(recordBoot(record, s.activeBoot)); err != nil {
				return result, err
			}
			segment = s.active
		}

		written, err := segment.file.Write(encoded)
		if err != nil {
			// A partial write abandons this identity and requires repair; the
			// accepted prefix stays durable-eligible as written.
			s.needsRepair = true
			result.NeedsRepair = true
			return result, err
		}
		segment.size += int64(written)
		s.nextSequence = sequence + 1
		s.lastSequence = sequence
		s.manifestDirty = true

		if result.Accepted == 0 {
			result.FirstSequence = sequence
		}
		result.Accepted++
		result.LastSequence = sequence
	}

	if result.Accepted > 0 {
		if err := s.publishInventoryLocked(); err != nil {
			result.NeedsRepair = true
			return result, err
		}
	}
	return result, nil
}

// Sync publishes the durable high-water sequence. Only a successful sync makes
// appended records durable; a failure leaves them in place for recovery.
func (s *Storage) Sync(ctx context.Context) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return 0, errors.New("journal: storage is closed")
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if s.active != nil && !s.active.sealed {
		if err := s.active.file.Sync(); err != nil {
			return s.durableThrough, err
		}
	}
	if s.manifestDirty {
		if err := writeManifest(s.fs, manifestPath(s.paths), s.manifest); err != nil {
			return s.durableThrough, err
		}
		s.manifestDirty = false
	}
	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		return s.durableThrough, err
	}
	s.durableThrough = s.lastSequence
	return s.durableThrough, nil
}

// RepairTail verifies the active segment and truncates an incomplete final
// frame so appends can continue.
func (s *Storage) RepairTail(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return errors.New("journal: storage is closed")
	}
	if s.active == nil {
		s.needsRepair = false
		return nil
	}

	raw, err := s.fs.ReadFile(filepath.Join(s.paths.JournalDir, s.active.name))
	if err != nil {
		return err
	}
	validBytes, lastSequence, _ := scanBytes(raw)

	segment := s.active
	if validBytes != segment.size {
		if err := segment.file.Truncate(validBytes); err != nil {
			return err
		}
		if _, err := segment.file.Seek(validBytes, io.SeekStart); err != nil {
			return err
		}
		if err := segment.file.Sync(); err != nil {
			return err
		}
		segment.size = validBytes
	}
	if lastSequence > s.lastSequence {
		s.lastSequence = lastSequence
	}
	s.needsRepair = false

	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		return err
	}
	return ctx.Err()
}

// Scan visits every durable record up to the given sequence. A zero `through`
// means every validated record.
func (s *Storage) Scan(ctx context.Context, through uint64, visit func(Record) error) error {
	s.mu.Lock()
	segments := append([]SegmentEntry(nil), s.manifest.Segments...)
	paths := s.paths
	fs := s.fs
	s.mu.Unlock()

	if visit == nil {
		return errors.New("journal: scan requires a visitor")
	}
	for _, entry := range segments {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := scanSegmentFile(fs, filepath.Join(paths.JournalDir, entry.Name), through, visit); err != nil {
			return err
		}
	}
	return nil
}

// reserveLocked durably reserves another block of sequences when the current
// reservation is exhausted.
func (s *Storage) reserveLocked() error {
	if s.nextSequence <= s.manifest.ReservedThrough {
		return nil
	}
	if s.manifest.ReservedThrough >= maxUint64-reservationBlock {
		return errors.New("journal: sequence space exhausted")
	}
	ceiling := s.manifest.ReservedThrough + reservationBlock
	if ceiling < s.nextSequence {
		if s.nextSequence > maxUint64-(reservationBlock-1) {
			return errors.New("journal: sequence space exhausted")
		}
		ceiling = s.nextSequence + reservationBlock - 1
	}
	candidate := s.manifest
	candidate.ReservedThrough = ceiling
	if err := writeManifest(s.fs, manifestPath(s.paths), candidate); err != nil {
		return err
	}
	s.manifest.ReservedThrough = ceiling
	s.manifestDirty = false
	return nil
}

// ensureSegmentLocked opens or resumes the writable segment for a boot.
func (s *Storage) ensureSegmentLocked(boot BootID) error {
	if s.active != nil && !s.active.sealed && s.active.boot == boot {
		return nil
	}
	if s.active != nil && !s.active.sealed {
		if err := s.sealActiveLocked(); err != nil {
			return err
		}
	}

	// Resume this boot's active segment when one exists.
	for i := len(s.manifest.Segments) - 1; i >= 0; i-- {
		entry := s.manifest.Segments[i]
		if entry.Sealed || entry.Boot != boot.String() {
			continue
		}
		file, err := s.fs.OpenFile(filepath.Join(s.paths.JournalDir, entry.Name), os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		if _, err := file.Seek(0, io.SeekEnd); err != nil {
			_ = file.Close()
			return err
		}
		s.active = &openSegment{name: entry.Name, file: file, boot: boot, segmentID: entry.SegmentID, size: entry.Bytes}
		s.activeBoot = boot
		return nil
	}

	segmentID := uint64(1)
	for _, entry := range s.manifest.Segments {
		if entry.SegmentID >= segmentID {
			segmentID = entry.SegmentID + 1
		}
	}
	name := fmt.Sprintf("%s%06d%s", segmentFilePrefix, segmentID, segmentFileExtension)
	path := filepath.Join(s.paths.JournalDir, name)

	header, err := EncodeHeader(Header{Boot: boot, SegmentID: segmentID, BootOrder: s.bootOrder, FirstSequence: s.nextSequence})
	if err != nil {
		return err
	}
	file, err := s.fs.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(header); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := s.fs.SyncDir(s.paths.JournalDir); err != nil {
		_ = file.Close()
		return err
	}

	s.active = &openSegment{name: name, file: file, boot: boot, segmentID: segmentID, size: int64(len(header))}
	s.activeBoot = boot
	s.manifest.Segments = append(s.manifest.Segments, SegmentEntry{
		Name:          name,
		Boot:          boot.String(),
		SegmentID:     segmentID,
		BootOrder:     s.bootOrder,
		FirstSequence: s.nextSequence,
	})
	s.manifestDirty = true
	return s.publishInventoryLocked()
}

// sealActiveLocked closes the active segment and marks it sealed.
func (s *Storage) sealActiveLocked() error {
	if s.active == nil {
		return nil
	}
	segment := s.active
	if err := segment.file.Sync(); err != nil {
		return err
	}
	if err := segment.file.Close(); err != nil {
		return err
	}
	segment.sealed = true
	for i := range s.manifest.Segments {
		if s.manifest.Segments[i].Name == segment.name {
			s.manifest.Segments[i].Sealed = true
			s.manifest.Segments[i].Bytes = segment.size
		}
	}
	s.active = nil
	s.manifestDirty = true
	return s.publishInventoryLocked()
}

// publishInventoryLocked writes the manifest when structural state changed.
func (s *Storage) publishInventoryLocked() error {
	if !s.manifestDirty {
		return nil
	}
	if err := writeManifest(s.fs, manifestPath(s.paths), s.manifest); err != nil {
		return err
	}
	s.manifestDirty = false
	return nil
}

// recordBoot extracts the boot a record belongs to. Publication and loss
// records carry no boot and inherit the active boot.
func recordBoot(record Record, active BootID) BootID {
	switch record.Kind {
	case KindSample:
		if sample, err := DecodeSample(record); err == nil {
			return sample.Boot
		}
	case KindAnchor:
		if anchor, err := DecodeAnchor(record); err == nil {
			return anchor.Boot
		}
	case KindClockTransition:
		if transition, err := DecodeClockTransition(record); err == nil {
			return transition.Boot
		}
	case KindBootStart:
		if bootStart, err := DecodeBootStart(record); err == nil {
			return bootStart.Boot
		}
	}
	return active
}

// validateKindData rejects a prepared record whose payload does not decode.
func validateKindData(record Record) error {
	var err error
	switch record.Kind {
	case KindSample:
		_, err = DecodeSample(record)
	case KindAnchor:
		_, err = DecodeAnchor(record)
	case KindClockTransition:
		_, err = DecodeClockTransition(record)
	case KindPublication:
		_, err = DecodePublication(record)
	case KindLoss:
		_, err = DecodeLoss(record)
	case KindBootStart:
		_, err = DecodeBootStart(record)
	default:
		return fmt.Errorf("%w: kind %d", ErrUnsupported, record.Kind)
	}
	return err
}
