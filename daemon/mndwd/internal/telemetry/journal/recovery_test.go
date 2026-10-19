package journal

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func encodedSampleFrame(t *testing.T, sequence uint64) []byte {
	t.Helper()

	prepared, err := PrepareSample(Sample{
		Boot:   BootID{1},
		Series: 1,
		Values: []Value{{Known: true, V: float64(sequence)}},
	})
	if err != nil {
		t.Fatal(err)
	}

	frame, err := EncodeRecord(Record{Kind: prepared.Kind, Seq: sequence, Payload: prepared.Payload})
	if err != nil {
		t.Fatal(err)
	}

	return frame
}

func TestScanBytesTornTailClassification(t *testing.T) {
	header, err := EncodeHeader(Header{Boot: BootID{1}, SegmentID: 1, FirstSequence: 1})
	if err != nil {
		t.Fatal(err)
	}

	firstFrame := encodedSampleFrame(t, 1)
	secondFrame := encodedSampleFrame(t, 2)
	thirdFrame := encodedSampleFrame(t, 3)
	prefix := len(header) + len(firstFrame) + len(secondFrame)
	base := append(append(append([]byte(nil), header...), firstFrame...), secondFrame...)

	zeroedFinalFrame := append([]byte(nil), thirdFrame...)

	for index := 4; index < len(zeroedFinalFrame); index++ {
		zeroedFinalFrame[index] = 0
	}

	badChecksum := append([]byte(nil), thirdFrame...)
	badChecksum[len(badChecksum)-1] ^= 1

	badSecondBodyThenFrame := append(append([]byte(nil), base...), thirdFrame...)
	secondFrameOffset := len(header) + len(firstFrame)
	badSecondBodyThenFrame[secondFrameOffset+4+3] ^= 1

	zeroGapThenFrame := append(append([]byte(nil), base...), make([]byte, 32)...)
	zeroGapThenFrame = append(zeroGapThenFrame, thirdFrame...)

	cases := []struct {
		name       string
		raw        []byte
		wantBytes  int64
		wantSeq    uint64
		wantDamage bool
	}{
		{name: "zero tail 135", raw: append(append([]byte(nil), base...), make([]byte, 135)...), wantBytes: int64(prefix), wantSeq: 2},
		{name: "zero tail 3", raw: append(append([]byte(nil), base...), make([]byte, 3)...), wantBytes: int64(prefix), wantSeq: 2},
		{name: "zeroed final body", raw: append(append([]byte(nil), base...), zeroedFinalFrame...), wantBytes: int64(prefix), wantSeq: 2},
		{name: "bad checksum at EOF", raw: append(append([]byte(nil), base...), badChecksum...), wantBytes: int64(prefix), wantSeq: 2},
		{name: "bad checksum then zeros", raw: append(append([]byte(nil), base...), append(badChecksum, make([]byte, 64)...)...), wantBytes: int64(prefix), wantSeq: 2},
		{name: "bad checksum then frame", raw: badSecondBodyThenFrame, wantBytes: int64(secondFrameOffset), wantSeq: 1, wantDamage: true},
		{name: "zero gap then frame", raw: zeroGapThenFrame, wantBytes: int64(prefix), wantSeq: 2, wantDamage: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			gotBytes, gotSequence, gotDamage := scanBytes(testCase.raw)

			if gotBytes != testCase.wantBytes || gotSequence != testCase.wantSeq || gotDamage != testCase.wantDamage {
				t.Fatalf("scanBytes() = (%d, %d, %v), want (%d, %d, %v)",
					gotBytes, gotSequence, gotDamage, testCase.wantBytes, testCase.wantSeq, testCase.wantDamage)
			}
		})
	}
}

func TestRecoveryTruncatesZeroFilledTail(t *testing.T) {
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	storage := opened.Writer

	for index := int64(0); index < 3; index++ {
		prepared, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: index,
			Values: []Value{{Known: true, V: float64(index)}}})
		if err != nil {
			t.Fatal(err)
		}

		if _, err := storage.Append(context.Background(), []Record{prepared}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	entry := storage.Manifest().Segments[0]
	segmentPath := filepath.Join(paths.JournalDir, entry.Name)

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	before, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	file, err := os.OpenFile(segmentPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write(make([]byte, 135)); err != nil {
		_ = file.Close()

		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	recovered, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	storage = recovered.Writer

	if recovered.Status.Mode != StatusReady {
		t.Fatalf("mode=%s, want ready", recovered.Status.Mode)
	}

	for _, issue := range recovered.Status.Issues {
		if issue.Code == issueSegmentDamaged {
			t.Fatalf("zero-filled tail reported as damaged: %+v", issue)
		}
	}

	if len(storage.Manifest().Segments) != 1 {
		t.Fatalf("segments=%d, want original segment retained", len(storage.Manifest().Segments))
	}

	stat, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	if stat.Size() != before.Size() {
		t.Fatalf("recovered size=%d, want %d before zero padding", stat.Size(), before.Size())
	}

	if got := countSamples(t, storage); got != 3 {
		t.Fatalf("recovered sample count=%d, want 3", got)
	}

	fourth, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: 3, Values: []Value{{Known: true, V: 3}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{fourth}); err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	defer reopened.Writer.Close()

	if got := countSamples(t, reopened.Writer); got != 4 {
		t.Fatalf("sample count after append/reopen=%d, want 4", got)
	}
}

func TestOpenReadOnlyReadsZeroTailedSegment(t *testing.T) {
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	storage := opened.Writer

	for index := int64(0); index < 3; index++ {
		prepared, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: index,
			Values: []Value{{Known: true, V: float64(index)}}})
		if err != nil {
			t.Fatal(err)
		}

		if _, err := storage.Append(context.Background(), []Record{prepared}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	entry := storage.Manifest().Segments[0]
	segmentPath := filepath.Join(paths.JournalDir, entry.Name)

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	file, err := os.OpenFile(segmentPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write(make([]byte, 135)); err != nil {
		_ = file.Close()

		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	before, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	readOnly, err := OpenReadOnly(context.Background(), paths, OSFileSystem{}, OSLocker{})
	if err != nil {
		t.Fatal(err)
	}

	defer readOnly.Reader.Close()

	if readOnly.Status.Mode != StatusReady {
		t.Fatalf("mode=%s, want ready", readOnly.Status.Mode)
	}

	for _, issue := range readOnly.Status.Issues {
		if issue.Code == issueSegmentDamaged {
			t.Fatalf("read-only scan reported zero tail as damaged: %+v", issue)
		}
	}

	if got := countReaderSamples(t, readOnly.Reader); got != 3 {
		t.Fatalf("read-only sample count=%d, want 3", got)
	}

	after, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	if after.Size() != before.Size() {
		t.Fatalf("read-only scan changed padded size from %d to %d", before.Size(), after.Size())
	}
}

func TestQuarantineKeepsEarlierEvidence(t *testing.T) {
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	storage := opened.Writer

	for index := int64(0); index < 3; index++ {
		appendSampleForTest(t, storage, BootID{1}, index)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	segmentName := storage.Manifest().Segments[0].Name

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	segmentPath := filepath.Join(paths.JournalDir, segmentName)
	raw, err := os.ReadFile(segmentPath)
	if err != nil {
		t.Fatal(err)
	}

	raw[headerBytes+20] ^= 0xff

	if err := os.WriteFile(segmentPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	firstTarget := filepath.Join(paths.JournalDir, quarantinePrefix+segmentName)

	if err := os.WriteFile(firstTarget, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	recovered, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	defer recovered.Writer.Close()

	oldEvidence, err := os.ReadFile(firstTarget)
	if err != nil {
		t.Fatal(err)
	}

	if string(oldEvidence) != "old" {
		t.Fatalf("earlier evidence overwritten: %q", oldEvidence)
	}

	secondTarget := firstTarget + ".2"
	newEvidence, err := os.ReadFile(secondTarget)
	if err != nil {
		t.Fatal(err)
	}

	if string(newEvidence) != string(raw) {
		t.Fatal("new quarantine file does not contain corrupted segment bytes")
	}

	for _, entry := range recovered.Writer.Manifest().Segments {
		if entry.Name == segmentName {
			t.Fatalf("quarantined segment remains in manifest: %+v", entry)
		}
	}
}

func countSamples(t *testing.T, storage *Storage) int {
	t.Helper()

	count := 0

	if err := storage.Scan(context.Background(), 0, func(record Record) error {
		if record.Kind == KindSample {
			count++
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	return count
}

func countReaderSamples(t *testing.T, reader *Reader) int {
	t.Helper()

	count := 0

	if err := reader.Scan(context.Background(), func(record Record) error {
		if record.Kind == KindSample {
			count++
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	return count
}
