package journal

import (
	"bytes"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadGoldenTestData(name string) []byte {
	raw, err := os.ReadFile(filepath.Join("testdata", "golden", name))
	if err != nil {
		panic(err)
	}

	decoded, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		panic(err)
	}

	return decoded
}

func loadGolden(t *testing.T, name string) []byte {
	t.Helper()

	return loadGoldenTestData(name)
}

func testBoot() BootID {
	var boot BootID

	for i := range boot {
		boot[i] = byte(i)
	}

	return boot
}

func TestCodecRejectsCorruption(t *testing.T) {
	encoded, err := EncodeRecord(Record{Kind: KindLoss, Seq: 7, Payload: []byte{1, 2, 3}})
	if err != nil {
		t.Fatal(err)
	}

	encoded[len(encoded)-5] ^= 1

	if _, err := DecodeRecord(bytes.NewReader(encoded)); !errors.Is(err, ErrChecksum) {
		t.Fatalf("corruption accepted: %v", err)
	}
}

func TestGoldenSampleFixture(t *testing.T) {
	encoded := loadGolden(t, "sample.hex")
	record, err := DecodeRecord(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}

	if record.Kind != KindSample || record.Seq != 1 {
		t.Fatalf("record=%+v seq=%d", record.Kind, record.Seq)
	}

	sample, err := DecodeSample(record)
	if err != nil {
		t.Fatal(err)
	}

	want := Sample{
		Seq:          1,
		Boot:         testBoot(),
		ClockSegment: 1,
		Series:       1,
		ElapsedMs:    180000,
		Values:       []Value{{Known: true, V: 20}, {Known: false}},
	}

	if sample.Seq != want.Seq || sample.Boot != want.Boot || sample.ClockSegment != want.ClockSegment ||
		sample.Series != want.Series || sample.ElapsedMs != want.ElapsedMs || len(sample.Values) != len(want.Values) {
		t.Fatalf("sample=%+v", sample)
	}

	for i := range want.Values {
		if sample.Values[i] != want.Values[i] {
			t.Fatalf("value %d = %+v", i, sample.Values[i])
		}
	}

	prepared, err := PrepareSample(Sample{
		Boot:         want.Boot,
		ClockSegment: want.ClockSegment,
		Series:       want.Series,
		ElapsedMs:    want.ElapsedMs,
		Values:       want.Values,
	})
	if err != nil {
		t.Fatal(err)
	}

	reencoded, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: 1, Payload: prepared.Payload})
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(reencoded, encoded) {
		t.Fatalf("re-encoded mismatch:\n got %x\nwant %x", reencoded, encoded)
	}
}

func TestGoldenFixturesDecode(t *testing.T) {
	anchor := loadGolden(t, "anchor.hex")
	record, err := DecodeRecord(bytes.NewReader(anchor))
	if err != nil {
		t.Fatal(err)
	}

	decodedAnchor, err := DecodeAnchor(record)
	if err != nil {
		t.Fatal(err)
	}

	if decodedAnchor.UTCMs != 1800000000000 || decodedAnchor.UncertaintyMs != 7 || decodedAnchor.EvidenceID != "ev-1" || decodedAnchor.EvidenceSource != "fixture" {
		t.Fatalf("anchor=%+v", decodedAnchor)
	}

	transitionRecord, err := DecodeRecord(bytes.NewReader(loadGolden(t, "clock-transition.hex")))
	if err != nil {
		t.Fatal(err)
	}

	transition, err := DecodeClockTransition(transitionRecord)
	if err != nil {
		t.Fatal(err)
	}

	if transition.State != StateSuspect || transition.SuspectElapsedMs == nil || *transition.SuspectElapsedMs != 60000 || transition.ConsumedEvidenceID != "ev-1" {
		t.Fatalf("transition=%+v", transition)
	}

	publicationRecord, err := DecodeRecord(bytes.NewReader(loadGolden(t, "publication.hex")))
	if err != nil {
		t.Fatal(err)
	}

	publication, err := DecodePublication(publicationRecord)
	if err != nil {
		t.Fatal(err)
	}

	if publication.SampleThrough != 10 || publication.AnchorThrough != 2 || len(publication.Frontiers) != 2 {
		t.Fatalf("publication=%+v", publication)
	}

	lossRecord, err := DecodeRecord(bytes.NewReader(loadGolden(t, "loss.hex")))
	if err != nil {
		t.Fatal(err)
	}

	loss, err := DecodeLoss(lossRecord)
	if err != nil {
		t.Fatal(err)
	}

	if loss.Reason != LossQueueOverflow || loss.Count != 3 || loss.Allocated == nil || loss.Allocated.First != 100 || loss.Allocated.Last != 102 {
		t.Fatalf("loss=%+v", loss)
	}

	bootStartRecord, err := DecodeRecord(bytes.NewReader(loadGolden(t, "boot-start.hex")))
	if err != nil {
		t.Fatal(err)
	}

	bootStart, err := DecodeBootStart(bootStartRecord)
	if err != nil {
		t.Fatal(err)
	}

	if bootStart.Boot != testBoot() || bootStart.FirstAcquireElapsedMs != 180000 || bootStart.Seq != 6 {
		t.Fatalf("bootStart=%+v", bootStart)
	}
}

func TestGoldenHeaderFixture(t *testing.T) {
	encoded := loadGolden(t, "header.hex")

	if len(encoded) != headerBytes {
		t.Fatalf("header length=%d", len(encoded))
	}

	decoded, err := DecodeHeader(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}

	want := Header{Boot: testBoot(), SegmentID: 1, BootOrder: 6, FirstSequence: 1}

	if decoded != want {
		t.Fatalf("header=%+v", decoded)
	}

	reencoded, err := EncodeHeader(want)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(reencoded, encoded) {
		t.Fatalf("re-encoded header mismatch:\n got %x\nwant %x", reencoded, encoded)
	}
}

func TestHeaderRejectsCorruption(t *testing.T) {
	encoded, err := EncodeHeader(Header{Boot: testBoot(), SegmentID: 1, BootOrder: 6, FirstSequence: 1})
	if err != nil {
		t.Fatal(err)
	}

	encoded[len(encoded)-1] ^= 1

	if _, err := DecodeHeader(bytes.NewReader(encoded)); !errors.Is(err, ErrChecksum) {
		t.Fatalf("corrupt header accepted: %v", err)
	}
}

func TestHeaderRejectsTruncatedAndUnknownVersion(t *testing.T) {
	encoded, err := EncodeHeader(Header{Boot: testBoot()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeHeader(bytes.NewReader(encoded[:40])); !errors.Is(err, ErrTruncatedTail) {
		t.Fatalf("truncated header accepted: %v", err)
	}

	mutated := append([]byte(nil), encoded...)
	mutated[8] = 2

	if _, err := DecodeHeader(bytes.NewReader(mutated)); !errors.Is(err, ErrChecksum) {
		t.Fatalf("changed version accepted: %v", err)
	}

	if _, err := DecodeHeader(bytes.NewReader(append([]byte("MNDWJNL2"), make([]byte, 48)...))); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unknown magic accepted: %v", err)
	}
}

func TestPrepareRejectsNonZeroSequence(t *testing.T) {
	sample := Sample{Seq: 7, Boot: testBoot(), Series: 1, Values: []Value{{Known: true, V: 1}}}

	if _, err := PrepareSample(sample); err == nil {
		t.Fatal("prepared sample with assigned sequence")
	}

	if _, err := PrepareAnchor(Anchor{Seq: 3}); err == nil {
		t.Fatal("prepared anchor with assigned sequence")
	}

	if _, err := PreparePublication(Publication{Seq: 3}); err == nil {
		t.Fatal("prepared publication with assigned sequence")
	}

	if _, err := PrepareClockTransition(ClockTransition{Seq: 3}); err == nil {
		t.Fatal("prepared transition with assigned sequence")
	}

	if _, err := PrepareLoss(Loss{Seq: 3}); err == nil {
		t.Fatal("prepared loss with assigned sequence")
	}

	if _, err := PrepareBootStart(BootStart{Seq: 3}); err == nil {
		t.Fatal("prepared boot start with assigned sequence")
	}
}

func TestEncodeRejectsZeroSequence(t *testing.T) {
	if _, err := EncodeRecord(Record{Kind: KindLoss, Payload: []byte{5, 0, 0, 0, 0, 0, 0, 0, 0}}); !errors.Is(err, ErrSequence) {
		t.Fatalf("zero sequence accepted: %v", err)
	}
}

func TestDecodeRejectsBodyLengthOutOfRange(t *testing.T) {
	for _, length := range []uint32{0, 9, 65537} {
		prefix := make([]byte, 4)
		prefix[0] = byte(length)
		prefix[1] = byte(length >> 8)
		prefix[2] = byte(length >> 16)
		prefix[3] = byte(length >> 24)
		reader := bytes.NewReader(append(prefix, make([]byte, 64)...))

		if _, err := DecodeRecord(reader); !errors.Is(err, ErrRecordLength) {
			t.Fatalf("length %d accepted: %v", length, err)
		}
	}
}

func TestDecodeRejectsTruncation(t *testing.T) {
	encoded, err := EncodeRecord(Record{Kind: KindBootStart, Seq: 1, Payload: mustPayload(t)})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeRecord(bytes.NewReader(encoded[:2])); !errors.Is(err, ErrTruncatedTail) {
		t.Fatalf("truncated prefix accepted: %v", err)
	}

	if _, err := DecodeRecord(bytes.NewReader(encoded[:len(encoded)-6])); !errors.Is(err, ErrTruncatedTail) {
		t.Fatalf("truncated body accepted: %v", err)
	}

	if _, err := DecodeRecord(bytes.NewReader(encoded[:len(encoded)-1])); !errors.Is(err, ErrTruncatedTail) {
		t.Fatalf("truncated checksum accepted: %v", err)
	}

	if _, err := DecodeRecord(bytes.NewReader(nil)); !errors.Is(err, io.EOF) && !errors.Is(err, ErrTruncatedTail) {
		t.Fatalf("empty input: %v", err)
	}
}

func mustPayload(t *testing.T) []byte {
	t.Helper()

	prepared, err := PrepareBootStart(BootStart{Boot: testBoot(), FirstAcquireElapsedMs: 1})
	if err != nil {
		t.Fatal(err)
	}

	return prepared.Payload
}

func TestDecodeRejectsUnknownKind(t *testing.T) {
	encoded, err := EncodeRecord(Record{Kind: Kind(99), Seq: 1, Payload: []byte{}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeRecord(bytes.NewReader(encoded)); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unknown kind accepted: %v", err)
	}
}

func TestEncodeUsesLittleEndianFraming(t *testing.T) {
	payload := []byte{0xaa, 0xbb}
	encoded, err := EncodeRecord(Record{Kind: KindLoss, Seq: 0x0102, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}

	// bodyBytes = kind(2) + sequence(8) + payload(2) = 12
	if got := uint32(encoded[0]) | uint32(encoded[1])<<8 | uint32(encoded[2])<<16 | uint32(encoded[3])<<24; got != 12 {
		t.Fatalf("bodyBytes=%d", got)
	}

	if encoded[4] != byte(KindLoss) || encoded[5] != 0 {
		t.Fatalf("kind bytes=%x", encoded[4:6])
	}

	if encoded[6] != 0x02 || encoded[7] != 0x01 {
		t.Fatalf("sequence bytes=%x", encoded[6:8])
	}

	if !bytes.Equal(encoded[14:16], payload) {
		t.Fatalf("payload=%x", encoded[14:16])
	}

	if len(encoded) != 4+12+4 {
		t.Fatalf("framing length=%d", len(encoded))
	}
}

func TestEncodedRecordLengthSurvivesDecodeWithVariableEvidenceStrings(t *testing.T) {
	prepared, err := PrepareAnchor(Anchor{
		Boot: testBoot(), ClockSegment: 8, ElapsedMs: 1234, UTCMs: 1800000000123, UncertaintyMs: 17,
		EvidenceID: "server@1234567890", EvidenceSource: "rci:clock-status-with-extra-fields",
	})
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: 42, Payload: prepared.Payload})
	if err != nil {
		t.Fatal(err)
	}

	decoded, err := DecodeRecord(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}

	reencoded, err := EncodeRecord(decoded)
	if err != nil {
		t.Fatal(err)
	}

	if len(reencoded) != len(encoded) {
		t.Fatalf("re-encoded frame length=%d, original=%d", len(reencoded), len(encoded))
	}
}

func TestSamplePreparationRejectsInvalidValues(t *testing.T) {
	base := Sample{Boot: testBoot(), Series: 1}
	nan := base
	nan.Values = []Value{{Known: true, V: math.NaN()}}

	if _, err := PrepareSample(nan); err == nil {
		t.Fatal("accepted NaN as a known value")
	}

	infinite := base
	infinite.Values = []Value{{Known: true, V: math.Inf(1)}}

	if _, err := PrepareSample(infinite); err == nil {
		t.Fatal("accepted infinity as a known value")
	}

	dirty := base
	dirty.Values = []Value{{Known: false, V: 12}}

	if _, err := PrepareSample(dirty); err == nil {
		t.Fatal("accepted a payload on an unknown value")
	}

	tooMany := base
	tooMany.Values = make([]Value, maxSampleValues+1)

	if _, err := PrepareSample(tooMany); err == nil {
		t.Fatalf("accepted %d values", len(tooMany.Values))
	}
}

func TestAnchorPreparationBoundsStrings(t *testing.T) {
	long := Anchor{Boot: testBoot(), EvidenceID: strings.Repeat("a", maxEvidenceIDBytes+1), EvidenceSource: "fixture"}

	if _, err := PrepareAnchor(long); err == nil {
		t.Fatal("accepted oversized evidence id")
	}

	longSource := Anchor{Boot: testBoot(), EvidenceID: "ev", EvidenceSource: strings.Repeat("a", maxEvidenceSourceBytes+1)}

	if _, err := PrepareAnchor(longSource); err == nil {
		t.Fatal("accepted oversized evidence source")
	}
}

func TestDecodeRejectsTrailingKindDataAndBadPresence(t *testing.T) {
	prepared, err := PrepareLoss(Loss{Reason: LossAge, Count: 1})
	if err != nil {
		t.Fatal(err)
	}

	withTrailing := append(append([]byte(nil), prepared.Payload...), 0)

	if _, err := DecodeLoss(Record{Kind: KindLoss, Seq: 1, Payload: withTrailing}); err == nil {
		t.Fatal("accepted trailing kindData")
	}

	badPresence := append([]byte(nil), prepared.Payload...)
	badPresence[len(badPresence)-1] = 2

	if _, err := DecodeLoss(Record{Kind: KindLoss, Seq: 1, Payload: badPresence}); err == nil {
		t.Fatal("accepted presence byte 2")
	}
}

func TestDecodeRejectsKindMismatch(t *testing.T) {
	prepared, err := PrepareLoss(Loss{Reason: LossAge, Count: 1})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeSample(Record{Kind: KindLoss, Seq: 1, Payload: prepared.Payload}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("kind mismatch accepted: %v", err)
	}
}

func TestRoundTripAllKinds(t *testing.T) {
	boot := testBoot()
	suspect := int64(60000)
	sample, err := PrepareSample(Sample{Boot: boot, ClockSegment: 1, Series: 2, ElapsedMs: 1000, Values: []Value{{Known: true, V: 41.5}, {Known: false}}})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 1000, UTCMs: 1800000000000, UncertaintyMs: 3, EvidenceID: "ev", EvidenceSource: "src"})
	if err != nil {
		t.Fatal(err)
	}

	transition, err := PrepareClockTransition(ClockTransition{Boot: boot, ClockSegment: 2, State: StateSuspect, SuspectElapsedMs: &suspect, ConsumedEvidenceID: "ev"})
	if err != nil {
		t.Fatal(err)
	}

	publication, err := PreparePublication(Publication{SampleThrough: 9, AnchorThrough: 1, CutoffElapsedMs: 1000, Frontiers: []Frontier{{Series: 1, SlotMs: 1800000000000}}})
	if err != nil {
		t.Fatal(err)
	}

	loss, err := PrepareLoss(Loss{Reason: LossBudget, Count: 4, Allocated: &SequenceRange{First: 10, Last: 13}})
	if err != nil {
		t.Fatal(err)
	}

	bootStart, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}

	for _, prepared := range []Record{sample, anchor, transition, publication, loss, bootStart} {
		encoded, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: 42, Payload: prepared.Payload})
		if err != nil {
			t.Fatal(err)
		}

		decoded, err := DecodeRecord(bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}

		if decoded.Kind != prepared.Kind || decoded.Seq != 42 {
			t.Fatalf("decoded=%+v seq=%d", decoded.Kind, decoded.Seq)
		}

		if !bytes.Equal(decoded.Payload, prepared.Payload) {
			t.Fatalf("payload mismatch for kind %d", prepared.Kind)
		}
	}

	decodedTransition, err := DecodeClockTransition(Record{Kind: transition.Kind, Seq: 42, Payload: transition.Payload})
	if err != nil {
		t.Fatal(err)
	}

	if decodedTransition.Seq != 42 || decodedTransition.SuspectElapsedMs == nil || *decodedTransition.SuspectElapsedMs != suspect {
		t.Fatalf("transition=%+v", decodedTransition)
	}

	decodedLoss, err := DecodeLoss(Record{Kind: loss.Kind, Seq: 42, Payload: loss.Payload})
	if err != nil {
		t.Fatal(err)
	}

	if decodedLoss.Allocated == nil || decodedLoss.Allocated.First != 10 || decodedLoss.Allocated.Last != 13 {
		t.Fatalf("loss=%+v", decodedLoss)
	}

	decodedBootStart, err := DecodeBootStart(Record{Kind: bootStart.Kind, Seq: 42, Payload: bootStart.Payload})
	if err != nil {
		t.Fatal(err)
	}

	if decodedBootStart.Seq != 42 || decodedBootStart.Boot != boot {
		t.Fatalf("bootStart=%+v", decodedBootStart)
	}
}
