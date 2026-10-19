package journal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
)

const (
	// magic identifies a version 1 journal file header.
	magic = "MNDWJNL1"
	// headerVersion is the only supported header version.
	headerVersion = 1
	// headerBytes is the fixed header size, including its checksum.
	headerBytes = 56
	// headerChecksumBytes covers the header fields preceding the checksum.
	headerChecksumBytes = 52

	// minBodyBytes is kind(2) + sequence(8) with empty kindData.
	minBodyBytes = 10
	// maxBodyBytes bounds a single encoded record body.
	maxBodyBytes = 65536

	// MaxSampleValues bounds one sample record's value count.
	MaxSampleValues = 16
	// MaxEvidenceIDBytes bounds a bounded evidence identifier string.
	MaxEvidenceIDBytes = 256
	// MaxEvidenceSourceBytes bounds a bounded evidence source string.
	MaxEvidenceSourceBytes = 128
	// MaxFrontiers bounds one publication record's frontier count.
	MaxFrontiers = 64

	maxSampleValues        = MaxSampleValues
	maxEvidenceIDBytes     = MaxEvidenceIDBytes
	maxEvidenceSourceBytes = MaxEvidenceSourceBytes
	maxFrontiers           = MaxFrontiers
)

var (
	// ErrTruncatedTail reports a header or record that ends before its declared
	// length.
	ErrTruncatedTail = errors.New("journal: truncated record")
	// ErrChecksum reports a framing or header checksum mismatch.
	ErrChecksum = errors.New("journal: checksum mismatch")
	// ErrRecordLength reports a record body length outside 10..65536. The
	// length is rejected before any allocation.
	ErrRecordLength = errors.New("journal: invalid record length")
	// ErrSequence reports a record sequence that is zero or reused.
	ErrSequence = errors.New("journal: invalid record sequence")
)

var crcTable = crc32.MakeTable(crc32.Castagnoli)

// Header is the fixed prefix of every segment file.
type Header struct {
	Boot          BootID
	SegmentID     uint64
	BootOrder     uint64
	FirstSequence uint64
}

// ErrValidation is a kindData validation failure. Decoders return it rather
// than panicking on malformed payloads.
var ErrValidation = errors.New("journal: invalid record payload")

func validationError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrValidation, fmt.Sprintf(format, args...))
}

// EncodeHeader serializes the fixed 56-byte segment header.
func EncodeHeader(header Header) ([]byte, error) {
	out := make([]byte, 0, headerBytes)
	out = append(out, magic...)
	out = binary.LittleEndian.AppendUint16(out, headerVersion)
	out = binary.LittleEndian.AppendUint16(out, headerBytes)
	out = append(out, header.Boot[:]...)
	out = binary.LittleEndian.AppendUint64(out, header.SegmentID)
	out = binary.LittleEndian.AppendUint64(out, header.BootOrder)
	out = binary.LittleEndian.AppendUint64(out, header.FirstSequence)
	sum := crc32.Update(0, crcTable, out)

	return binary.LittleEndian.AppendUint32(out, sum), nil
}

// DecodeHeader reads and validates a fixed segment header.
func DecodeHeader(reader io.Reader) (Header, error) {
	raw := make([]byte, headerBytes)

	if _, err := io.ReadFull(reader, raw); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Header{}, ErrTruncatedTail
		}

		return Header{}, err
	}

	if string(raw[:len(magic)]) != magic {
		return Header{}, ErrUnsupported
	}

	if err := verifyChecksum(raw[:headerChecksumBytes], raw[headerChecksumBytes:]); err != nil {
		return Header{}, err
	}

	if version := binary.LittleEndian.Uint16(raw[8:]); version != headerVersion {
		return Header{}, ErrUnsupported
	}

	if declared := binary.LittleEndian.Uint16(raw[10:]); declared != headerBytes {
		return Header{}, ErrUnsupported
	}

	var header Header

	copy(header.Boot[:], raw[12:28])

	header.SegmentID = binary.LittleEndian.Uint64(raw[28:])
	header.BootOrder = binary.LittleEndian.Uint64(raw[36:])
	header.FirstSequence = binary.LittleEndian.Uint64(raw[44:])

	return header, nil
}

// EncodeRecord serializes one record, including its length prefix and
// checksum. It rejects a zero sequence: only the store may allocate one.
func EncodeRecord(record Record) ([]byte, error) {
	if record.Seq == 0 {
		return nil, ErrSequence
	}

	body := make([]byte, 0, 10+len(record.Payload))
	body = binary.LittleEndian.AppendUint16(body, uint16(record.Kind))
	body = binary.LittleEndian.AppendUint64(body, record.Seq)
	body = append(body, record.Payload...)

	if len(body) > maxBodyBytes {
		return nil, ErrRecordLength
	}

	out := binary.LittleEndian.AppendUint32(nil, uint32(len(body)))
	out = append(out, body...)
	sum := crc32.Update(0, crcTable, out)

	return binary.LittleEndian.AppendUint32(out, sum), nil
}

// DecodeRecord reads one framed record. It validates the length before
// allocating and never scans for candidate record boundaries.
func DecodeRecord(reader io.Reader) (Record, error) {
	prefix := make([]byte, 4)

	if _, err := io.ReadFull(reader, prefix); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Record{}, ErrTruncatedTail
		}

		return Record{}, err
	}

	length := binary.LittleEndian.Uint32(prefix)

	if length < minBodyBytes || length > maxBodyBytes {
		return Record{}, ErrRecordLength
	}

	body := make([]byte, int(length))

	if _, err := io.ReadFull(reader, body); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Record{}, ErrTruncatedTail
		}

		return Record{}, err
	}

	checksum := make([]byte, 4)

	if _, err := io.ReadFull(reader, checksum); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Record{}, ErrTruncatedTail
		}

		return Record{}, err
	}

	sum := crc32.Update(0, crcTable, prefix)
	sum = crc32.Update(sum, crcTable, body)

	if err := verifyChecksum(nil, checksum, sum); err != nil {
		return Record{}, err
	}

	kind := Kind(binary.LittleEndian.Uint16(body))

	switch kind {
	case KindSample, KindAnchor, KindClockTransition, KindPublication, KindLoss, KindBootStart:
	default:
		return Record{}, fmt.Errorf("%w: kind %d", ErrUnsupported, kind)
	}

	return Record{
		Kind:    kind,
		Seq:     binary.LittleEndian.Uint64(body[2:]),
		Payload: body[10:],
	}, nil
}

func verifyChecksum(payload []byte, stored []byte, computed ...uint32) error {
	var want uint32

	if len(computed) > 0 {
		want = computed[0]
	} else {
		want = crc32.Update(0, crcTable, payload)
	}

	if got := binary.LittleEndian.Uint32(stored); got != want {
		return ErrChecksum
	}

	return nil
}

// kindReader decodes bounded fields from kindData and reports any trailing or
// missing bytes.
type kindReader struct {
	kind Kind
	rest []byte
}

func newKindReader(kind Kind, payload []byte) *kindReader {
	return &kindReader{kind: kind, rest: payload}
}

func (r *kindReader) take(n int) ([]byte, error) {
	if len(r.rest) < n {
		return nil, validationError("kind %d needs %d bytes, has %d", r.kind, n, len(r.rest))
	}

	out := r.rest[:n]
	r.rest = r.rest[n:]

	return out, nil
}

func (r *kindReader) uint16() (uint16, error) {
	raw, err := r.take(2)
	if err != nil {
		return 0, err
	}

	return binary.LittleEndian.Uint16(raw), nil
}

func (r *kindReader) uint64() (uint64, error) {
	raw, err := r.take(8)
	if err != nil {
		return 0, err
	}

	return binary.LittleEndian.Uint64(raw), nil
}

func (r *kindReader) int64() (int64, error) {
	raw, err := r.take(8)
	if err != nil {
		return 0, err
	}

	return int64(binary.LittleEndian.Uint64(raw)), nil
}

func (r *kindReader) boot() (BootID, error) {
	raw, err := r.take(16)
	if err != nil {
		return BootID{}, err
	}

	var boot BootID

	copy(boot[:], raw)

	return boot, nil
}

func (r *kindReader) byte() (byte, error) {
	raw, err := r.take(1)
	if err != nil {
		return 0, err
	}

	return raw[0], nil
}

func (r *kindReader) boundedString(limit int) (string, error) {
	length, err := r.uint16()
	if err != nil {
		return "", err
	}

	if int(length) > limit {
		return "", validationError("string length %d exceeds %d", length, limit)
	}

	raw, err := r.take(int(length))
	if err != nil {
		return "", err
	}

	return string(raw), nil
}

func (r *kindReader) presence() (bool, error) {
	flag, err := r.byte()
	if err != nil {
		return false, err
	}

	switch flag {
	case 0:
		return false, nil
	case 1:
		return true, nil
	default:
		return false, validationError("presence byte %d is not 0 or 1", flag)
	}
}

func (r *kindReader) done() error {
	if len(r.rest) != 0 {
		return validationError("kind %d has %d trailing bytes", r.kind, len(r.rest))
	}

	return nil
}

func requireKind(record Record, want Kind) error {
	if record.Kind != want {
		return fmt.Errorf("%w: kind %d is not %d", ErrUnsupported, record.Kind, want)
	}

	return nil
}

func requireZeroSequence(seq uint64) error {
	if seq != 0 {
		return fmt.Errorf("%w: preparation requires sequence 0, got %d", ErrSequence, seq)
	}

	return nil
}

// PrepareSample encodes sample kindData. The record carries no sequence yet.
func PrepareSample(sample Sample) (Record, error) {
	if err := requireZeroSequence(sample.Seq); err != nil {
		return Record{}, err
	}

	if len(sample.Values) > maxSampleValues {
		return Record{}, validationError("sample has %d values, limit %d", len(sample.Values), maxSampleValues)
	}

	out := make([]byte, 0, 36+len(sample.Values)*9)
	out = append(out, sample.Boot[:]...)
	out = binary.LittleEndian.AppendUint64(out, sample.ClockSegment)
	out = binary.LittleEndian.AppendUint16(out, sample.Series)
	out = binary.LittleEndian.AppendUint64(out, uint64(sample.ElapsedMs))
	out = binary.LittleEndian.AppendUint16(out, uint16(len(sample.Values)))

	for _, value := range sample.Values {
		if !value.Known {
			if value.V != 0 {
				return Record{}, validationError("unknown value must not carry a payload, got %v", value.V)
			}

			out = append(out, 0)
			out = binary.LittleEndian.AppendUint64(out, 0)

			continue
		}

		if math.IsNaN(value.V) || math.IsInf(value.V, 0) {
			return Record{}, validationError("known sample value is not finite: %v", value.V)
		}

		out = append(out, 1)
		out = binary.LittleEndian.AppendUint64(out, math.Float64bits(value.V))
	}

	return Record{Kind: KindSample, Payload: out}, nil
}

// DecodeSample decodes sample kindData and restores the envelope sequence.
func DecodeSample(record Record) (Sample, error) {
	if err := requireKind(record, KindSample); err != nil {
		return Sample{}, err
	}

	reader := newKindReader(KindSample, record.Payload)
	boot, err := reader.boot()
	if err != nil {
		return Sample{}, err
	}

	segment, err := reader.uint64()
	if err != nil {
		return Sample{}, err
	}

	series, err := reader.uint16()
	if err != nil {
		return Sample{}, err
	}

	elapsed, err := reader.int64()
	if err != nil {
		return Sample{}, err
	}

	count, err := reader.uint16()
	if err != nil {
		return Sample{}, err
	}

	if int(count) > maxSampleValues {
		return Sample{}, validationError("sample declares %d values, limit %d", count, maxSampleValues)
	}

	sample := Sample{Seq: record.Seq, Boot: boot, ClockSegment: segment, Series: series, ElapsedMs: elapsed}

	for i := 0; i < int(count); i++ {
		known, err := reader.byte()
		if err != nil {
			return Sample{}, err
		}

		bits, err := reader.uint64()
		if err != nil {
			return Sample{}, err
		}

		switch known {
		case 0:
			if bits != 0 {
				return Sample{}, validationError("unknown value carries payload bits")
			}

			sample.Values = append(sample.Values, Value{Known: false})
		case 1:
			sample.Values = append(sample.Values, Value{Known: true, V: math.Float64frombits(bits)})
		default:
			return Sample{}, validationError("value known byte %d is not 0 or 1", known)
		}
	}

	if err := reader.done(); err != nil {
		return Sample{}, err
	}

	return sample, nil
}

// PrepareAnchor encodes anchor kindData.
func PrepareAnchor(anchor Anchor) (Record, error) {
	if err := requireZeroSequence(anchor.Seq); err != nil {
		return Record{}, err
	}

	if len(anchor.EvidenceID) > maxEvidenceIDBytes {
		return Record{}, validationError("evidence id is %d bytes, limit %d", len(anchor.EvidenceID), maxEvidenceIDBytes)
	}

	if len(anchor.EvidenceSource) > maxEvidenceSourceBytes {
		return Record{}, validationError("evidence source is %d bytes, limit %d", len(anchor.EvidenceSource), maxEvidenceSourceBytes)
	}

	out := make([]byte, 0, 48+len(anchor.EvidenceID)+len(anchor.EvidenceSource)+4)
	out = append(out, anchor.Boot[:]...)
	out = binary.LittleEndian.AppendUint64(out, anchor.ClockSegment)
	out = binary.LittleEndian.AppendUint64(out, uint64(anchor.ElapsedMs))
	out = binary.LittleEndian.AppendUint64(out, uint64(anchor.UTCMs))
	out = binary.LittleEndian.AppendUint64(out, uint64(anchor.UncertaintyMs))
	out = binary.LittleEndian.AppendUint16(out, uint16(len(anchor.EvidenceID)))
	out = append(out, anchor.EvidenceID...)
	out = binary.LittleEndian.AppendUint16(out, uint16(len(anchor.EvidenceSource)))
	out = append(out, anchor.EvidenceSource...)

	return Record{Kind: KindAnchor, Payload: out}, nil
}

// DecodeAnchor decodes anchor kindData.
func DecodeAnchor(record Record) (Anchor, error) {
	if err := requireKind(record, KindAnchor); err != nil {
		return Anchor{}, err
	}

	reader := newKindReader(KindAnchor, record.Payload)
	boot, err := reader.boot()
	if err != nil {
		return Anchor{}, err
	}

	segment, err := reader.uint64()
	if err != nil {
		return Anchor{}, err
	}

	elapsed, err := reader.int64()
	if err != nil {
		return Anchor{}, err
	}

	utc, err := reader.int64()
	if err != nil {
		return Anchor{}, err
	}

	uncertainty, err := reader.int64()
	if err != nil {
		return Anchor{}, err
	}

	evidenceID, err := reader.boundedString(maxEvidenceIDBytes)
	if err != nil {
		return Anchor{}, err
	}

	evidenceSource, err := reader.boundedString(maxEvidenceSourceBytes)
	if err != nil {
		return Anchor{}, err
	}

	if err := reader.done(); err != nil {
		return Anchor{}, err
	}

	return Anchor{
		Seq:            record.Seq,
		Boot:           boot,
		ClockSegment:   segment,
		ElapsedMs:      elapsed,
		UTCMs:          utc,
		UncertaintyMs:  uncertainty,
		EvidenceID:     evidenceID,
		EvidenceSource: evidenceSource,
	}, nil
}

// PrepareClockTransition encodes clock-transition kindData.
func PrepareClockTransition(transition ClockTransition) (Record, error) {
	if err := requireZeroSequence(transition.Seq); err != nil {
		return Record{}, err
	}

	if len(transition.ConsumedEvidenceID) > maxEvidenceIDBytes {
		return Record{}, validationError("evidence id is %d bytes, limit %d", len(transition.ConsumedEvidenceID), maxEvidenceIDBytes)
	}

	if transition.State != StateUnanchored && transition.State != StateAnchored && transition.State != StateSuspect {
		return Record{}, validationError("unknown clock state %d", transition.State)
	}

	out := make([]byte, 0, 32+len(transition.ConsumedEvidenceID))
	out = append(out, transition.Boot[:]...)
	out = binary.LittleEndian.AppendUint64(out, transition.ClockSegment)
	out = append(out, byte(transition.State))

	if transition.SuspectElapsedMs != nil {
		out = append(out, 1)
		out = binary.LittleEndian.AppendUint64(out, uint64(*transition.SuspectElapsedMs))
	} else {
		out = append(out, 0)
	}

	out = binary.LittleEndian.AppendUint16(out, uint16(len(transition.ConsumedEvidenceID)))
	out = append(out, transition.ConsumedEvidenceID...)

	return Record{Kind: KindClockTransition, Payload: out}, nil
}

// DecodeClockTransition decodes clock-transition kindData.
func DecodeClockTransition(record Record) (ClockTransition, error) {
	if err := requireKind(record, KindClockTransition); err != nil {
		return ClockTransition{}, err
	}

	reader := newKindReader(KindClockTransition, record.Payload)
	boot, err := reader.boot()
	if err != nil {
		return ClockTransition{}, err
	}

	segment, err := reader.uint64()
	if err != nil {
		return ClockTransition{}, err
	}

	state, err := reader.byte()
	if err != nil {
		return ClockTransition{}, err
	}

	present, err := reader.presence()
	if err != nil {
		return ClockTransition{}, err
	}

	var suspect *int64

	if present {
		elapsed, err := reader.int64()
		if err != nil {
			return ClockTransition{}, err
		}

		value := elapsed
		suspect = &value
	}

	consumed, err := reader.boundedString(maxEvidenceIDBytes)
	if err != nil {
		return ClockTransition{}, err
	}

	if err := reader.done(); err != nil {
		return ClockTransition{}, err
	}

	return ClockTransition{
		Seq:                record.Seq,
		Boot:               boot,
		ClockSegment:       segment,
		State:              TransitionState(state),
		SuspectElapsedMs:   suspect,
		ConsumedEvidenceID: consumed,
	}, nil
}

// PreparePublication encodes publication-boundary kindData.
func PreparePublication(publication Publication) (Record, error) {
	if err := requireZeroSequence(publication.Seq); err != nil {
		return Record{}, err
	}

	if len(publication.Frontiers) > maxFrontiers {
		return Record{}, validationError("publication has %d frontiers, limit %d", len(publication.Frontiers), maxFrontiers)
	}

	out := make([]byte, 0, 26+len(publication.Frontiers)*10)
	out = binary.LittleEndian.AppendUint64(out, publication.SampleThrough)
	out = binary.LittleEndian.AppendUint64(out, publication.AnchorThrough)
	out = binary.LittleEndian.AppendUint64(out, uint64(publication.CutoffElapsedMs))
	out = binary.LittleEndian.AppendUint16(out, uint16(len(publication.Frontiers)))

	for _, frontier := range publication.Frontiers {
		out = binary.LittleEndian.AppendUint16(out, frontier.Series)
		out = binary.LittleEndian.AppendUint64(out, uint64(frontier.SlotMs))
	}

	return Record{Kind: KindPublication, Payload: out}, nil
}

// DecodePublication decodes publication-boundary kindData.
func DecodePublication(record Record) (Publication, error) {
	if err := requireKind(record, KindPublication); err != nil {
		return Publication{}, err
	}

	reader := newKindReader(KindPublication, record.Payload)
	sampleThrough, err := reader.uint64()
	if err != nil {
		return Publication{}, err
	}

	anchorThrough, err := reader.uint64()
	if err != nil {
		return Publication{}, err
	}

	cutoff, err := reader.int64()
	if err != nil {
		return Publication{}, err
	}

	count, err := reader.uint16()
	if err != nil {
		return Publication{}, err
	}

	if int(count) > maxFrontiers {
		return Publication{}, validationError("publication declares %d frontiers, limit %d", count, maxFrontiers)
	}

	publication := Publication{
		Seq:             record.Seq,
		SampleThrough:   sampleThrough,
		AnchorThrough:   anchorThrough,
		CutoffElapsedMs: cutoff,
	}

	for i := 0; i < int(count); i++ {
		series, err := reader.uint16()
		if err != nil {
			return Publication{}, err
		}

		slot, err := reader.int64()
		if err != nil {
			return Publication{}, err
		}

		publication.Frontiers = append(publication.Frontiers, Frontier{Series: series, SlotMs: slot})
	}

	if err := reader.done(); err != nil {
		return Publication{}, err
	}

	return publication, nil
}

// PrepareLoss encodes loss kindData.
func PrepareLoss(loss Loss) (Record, error) {
	if err := requireZeroSequence(loss.Seq); err != nil {
		return Record{}, err
	}

	if loss.Reason < LossAge || loss.Reason > LossQueueOverflow {
		return Record{}, validationError("unknown loss reason %d", loss.Reason)
	}

	if loss.Allocated != nil && loss.Allocated.Last < loss.Allocated.First {
		return Record{}, validationError("allocated range ends before it starts")
	}

	out := make([]byte, 0, 26)
	out = append(out, byte(loss.Reason))
	out = binary.LittleEndian.AppendUint64(out, loss.Count)

	if loss.Allocated != nil {
		out = append(out, 1)
		out = binary.LittleEndian.AppendUint64(out, loss.Allocated.First)
		out = binary.LittleEndian.AppendUint64(out, loss.Allocated.Last)
	} else {
		out = append(out, 0)
	}

	return Record{Kind: KindLoss, Payload: out}, nil
}

// DecodeLoss decodes loss kindData.
func DecodeLoss(record Record) (Loss, error) {
	if err := requireKind(record, KindLoss); err != nil {
		return Loss{}, err
	}

	reader := newKindReader(KindLoss, record.Payload)
	reason, err := reader.byte()
	if err != nil {
		return Loss{}, err
	}

	count, err := reader.uint64()
	if err != nil {
		return Loss{}, err
	}

	present, err := reader.presence()
	if err != nil {
		return Loss{}, err
	}

	var allocated *SequenceRange

	if present {
		first, err := reader.uint64()
		if err != nil {
			return Loss{}, err
		}

		last, err := reader.uint64()
		if err != nil {
			return Loss{}, err
		}

		allocated = &SequenceRange{First: first, Last: last}
	}

	if err := reader.done(); err != nil {
		return Loss{}, err
	}

	return Loss{Seq: record.Seq, Reason: LossReason(reason), Count: count, Allocated: allocated}, nil
}

// PrepareBootStart encodes boot-start kindData.
func PrepareBootStart(bootStart BootStart) (Record, error) {
	if err := requireZeroSequence(bootStart.Seq); err != nil {
		return Record{}, err
	}

	out := make([]byte, 0, 24)
	out = append(out, bootStart.Boot[:]...)
	out = binary.LittleEndian.AppendUint64(out, uint64(bootStart.FirstAcquireElapsedMs))

	return Record{Kind: KindBootStart, Payload: out}, nil
}

// DecodeBootStart decodes boot-start kindData.
func DecodeBootStart(record Record) (BootStart, error) {
	if err := requireKind(record, KindBootStart); err != nil {
		return BootStart{}, err
	}

	reader := newKindReader(KindBootStart, record.Payload)
	boot, err := reader.boot()
	if err != nil {
		return BootStart{}, err
	}

	elapsed, err := reader.int64()
	if err != nil {
		return BootStart{}, err
	}

	if err := reader.done(); err != nil {
		return BootStart{}, err
	}

	return BootStart{Seq: record.Seq, Boot: boot, FirstAcquireElapsedMs: elapsed}, nil
}
