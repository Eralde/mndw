package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRetentionDoesNotUseUntrustedWallTime(t *testing.T) {
	input := RetentionInput{LatestElapsed: map[BootID]int64{{1}: 4 * 60 * 60 * 1000}}
	if expiredSample(Sample{Boot: BootID{1}, ElapsedMs: 0}, nil, input, 30*24*time.Hour) {
		t.Fatal("four-hour unknown boot expired")
	}
}

func TestRetentionExpiresDatedSamplesWithTrustedNow(t *testing.T) {
	now := int64(1800000000000)
	input := RetentionInput{TrustedNowMs: &now}

	mapped := now - 40*24*time.Hour.Milliseconds()
	if !expiredSample(Sample{Boot: BootID{1}}, &mapped, input, 30*24*time.Hour) {
		t.Fatal("sample older than retention kept")
	}
	fresh := now - time.Hour.Milliseconds()
	if expiredSample(Sample{Boot: BootID{1}}, &fresh, input, 30*24*time.Hour) {
		t.Fatal("fresh sample expired")
	}
	// Without trustworthy now, a dated record is never aged.
	if expiredSample(Sample{Boot: BootID{1}}, &mapped, RetentionInput{}, 30*24*time.Hour) {
		t.Fatal("dated sample expired without trusted now")
	}
}

func TestRetentionAgesUnknownBootsByOwnElapsed(t *testing.T) {
	input := RetentionInput{LatestElapsed: map[BootID]int64{{1}: 40 * 24 * time.Hour.Milliseconds()}}
	if !expiredSample(Sample{Boot: BootID{1}, ElapsedMs: 0}, nil, input, 30*24*time.Hour) {
		t.Fatal("unknown boot not trimmed against its own elapsed progress")
	}
	if expiredSample(Sample{Boot: BootID{2}, ElapsedMs: 0}, nil, input, 30*24*time.Hour) {
		t.Fatal("fabricated age between unknown boots")
	}
}

func TestMaintainEvictsOldestSegmentsUnderBudget(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 512
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	boot := BootID{1}
	for i := 0; i < 12; i++ {
		record, err := PrepareSample(Sample{Boot: boot, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := len(storage.Manifest().Segments)
	if before < 2 {
		t.Fatalf("segments=%d", before)
	}

	if err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}
	after := storage.Manifest().Segments
	if len(after) >= before {
		t.Fatalf("budget eviction removed nothing: %d -> %d", before, len(after))
	}
	if storage.totalBytesLocked(&retentionScan{}) > limits.Bytes {
		t.Fatal("budget exceeded after maintenance")
	}
}

func TestMaintainReportsPinPressure(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 64
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	record, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	lease, err := storage.Pin(1)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()

	if err := storage.Maintain(context.Background(), RetentionInput{}); !errors.Is(err, ErrPinPressure) {
		t.Fatalf("pin pressure not reported: %v", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := storage.Maintain(context.Background(), RetentionInput{}); errors.Is(err, ErrPinPressure) {
		t.Fatal("pin still blocking after release")
	}
}

func TestMaintainEnforcesSessionLimit(t *testing.T) {
	limits := DefaultLimits()
	limits.Sessions = 1
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for _, boot := range []BootID{{1}, {2}} {
		start, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storage.Append(context.Background(), []Record{start}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}
	if len(storage.Manifest().Segments) != 1 {
		t.Fatalf("segments=%d", len(storage.Manifest().Segments))
	}
}

func TestCoverageReportsAnchoredExtentAndUnanchoredReason(t *testing.T) {
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})

	booted := BootID{9}
	start, err := PrepareBootStart(BootStart{Boot: booted, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := PrepareAnchor(Anchor{Boot: booted, ElapsedMs: 1000, UTCMs: 1800000000000})
	if err != nil {
		t.Fatal(err)
	}
	sample, err := PrepareSample(Sample{Boot: booted, Series: 1, ElapsedMs: 1000, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := PrepareSample(Sample{Boot: BootID{8}, Series: 2, ElapsedMs: 1000, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{start, anchor, sample, unknown}); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	coverage := storage.Coverage()
	if len(coverage) != 2 {
		t.Fatalf("coverage=%+v", coverage)
	}
	if coverage[0].Series != 1 || coverage[0].StartMs == nil || *coverage[0].StartMs != 1800000000000 {
		t.Fatalf("anchored coverage=%+v", coverage[0])
	}
	if coverage[0].EndMs == nil || *coverage[0].EndMs != 1800000000000 {
		t.Fatalf("anchored end=%v", coverage[0].EndMs)
	}
	if !coverage[1].Complete && len(coverage[1].Reasons) == 0 {
		t.Fatalf("unanchored series not explained: %+v", coverage[1])
	}
}

func TestCompactionPreservesRetainedSequences(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 512
	limits.Bytes = 4096
	limits.ScratchBytes = 1 << 20
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	boot := BootID{1}
	start, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{start}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		record, err := PrepareSample(Sample{Boot: boot, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: float64(i)}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Expire every sample of the first segment but keep its boot start.
	oldest := storage.Manifest().Segments[0].Name
	scan, _, err := storage.scanRetentionLocked()
	if err != nil {
		t.Fatal(err)
	}
	storage.retention = RetentionInput{TrustedNowMs: nil}
	compacted, err := storage.compactSegmentLocked(context.Background(), storage.Manifest().Segments[0], scan)
	if err != nil {
		t.Fatal(err)
	}
	if !compacted {
		t.Fatal("compaction declined a partially live segment")
	}

	var sequences []uint64
	if err := storage.Scan(context.Background(), 0, func(record Record) error {
		sequences = append(sequences, record.Seq)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(sequences) == 0 {
		t.Fatal("compaction dropped every record")
	}
	for i := 1; i < len(sequences); i++ {
		if sequences[i] <= sequences[i-1] {
			t.Fatalf("sequence order broken: %v", sequences)
		}
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, compactionTempPrefix+oldest)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("compaction left a temporary file: %v", err)
	}
}

func TestCleanupCompactionTempsRemovesOnlyIdentifiableOrphans(t *testing.T) {
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})
	if err := os.WriteFile(filepath.Join(paths.JournalDir, compactionTempPrefix+"seg-000001.jnl"), []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.JournalDir, "keep-me.txt"), []byte("evidence"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := storage.cleanupCompactionTemps(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, compactionTempPrefix+"seg-000001.jnl")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, "keep-me.txt")); err != nil {
		t.Fatalf("unrelated file removed: %v", err)
	}
}
