package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func reopenAfterCrash(t *testing.T, paths StoragePaths, limits Limits) *Storage {
	t.Helper()

	fs := OSFileSystem{}
	manifest, err := loadManifest(fs, manifestPath(paths))
	if err != nil {
		t.Fatal(err)
	}

	lastByBoot := map[string]int{}

	for index, entry := range manifest.Segments {
		lastByBoot[entry.Boot] = index
		manifest.Segments[index].Sealed = true
	}

	for _, index := range lastByBoot {
		manifest.Segments[index].Sealed = false
	}

	if err := writeManifest(fs, manifestPath(paths), manifest); err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, fs, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	if opened.Writer == nil || opened.Status.Mode != StatusReady {
		t.Fatalf("reopen after crash status=%+v", opened.Status)
	}

	t.Cleanup(func() { _ = opened.Writer.Close() })

	return opened.Writer
}

func journalFileBytes(t *testing.T, storage *Storage, paths StoragePaths) int64 {
	t.Helper()

	var total int64

	for _, entry := range storage.Manifest().Segments {
		info, err := os.Stat(filepath.Join(paths.JournalDir, entry.Name))
		if err != nil {
			t.Fatal(err)
		}

		total += info.Size()
	}

	return total
}

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

	result, err := storage.Maintain(context.Background(), RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if !result.InventoryChanged {
		t.Fatal("budget eviction did not report inventory change")
	}

	after := storage.Manifest().Segments

	if len(after) >= before {
		t.Fatalf("budget eviction removed nothing: %d -> %d", before, len(after))
	}

	if storage.totalBytesLocked(&retentionScan{}) > limits.Bytes {
		t.Fatal("budget exceeded after maintenance")
	}
}

func TestDropKeepsLossRecordWithActiveWriter(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 600
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{1}

	for index := int64(0); index < 12; index++ {
		appendSampleForTest(t, storage, boot, index)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	storage.limits.SegmentBytes = 1 << 20

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	for _, elapsed := range []int64{100, 101, 102} {
		appendSampleForTest(t, storage, boot, elapsed)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	defer reopened.Writer.Close()

	if len(reopened.Status.Issues) > 0 {
		t.Fatalf("recovery issues after retention: %+v", reopened.Status.Issues)
	}

	entries := scanManifestRecordsForTest(t, reopened.Writer)
	lastLoss := -1

	for index, entry := range entries {
		if entry.record.Kind == KindLoss {
			lastLoss = index
		}
	}

	if lastLoss < 0 {
		t.Fatal("retention loss record was overwritten")
	}

	var elapsedAfterLoss []int64

	for _, entry := range entries[lastLoss+1:] {
		if entry.record.Kind != KindSample {
			continue
		}

		sample, err := DecodeSample(entry.record)
		if err != nil {
			t.Fatal(err)
		}

		if sample.ElapsedMs >= 100 {
			elapsedAfterLoss = append(elapsedAfterLoss, sample.ElapsedMs)
		}
	}

	if len(elapsedAfterLoss) != 3 || elapsedAfterLoss[0] != 100 || elapsedAfterLoss[1] != 101 || elapsedAfterLoss[2] != 102 {
		t.Fatalf("samples after last loss=%v, want [100 101 102]", elapsedAfterLoss)
	}
}

func TestDropWithoutWriterDefersLossRecord(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for index := int64(0); index < 12; index++ {
		appendSampleForTest(t, storage, BootID{1}, index)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	limits.Bytes = 400
	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	defer opened.Writer.Close()

	if _, err := opened.Writer.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	assertNoZeroBootSegmentsForTest(t, opened.Writer)

	appendSampleForTest(t, opened.Writer, BootID{1}, 100)

	if _, err := opened.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	entries := scanManifestRecordsForTest(t, opened.Writer)
	found := false

	for index := 1; index < len(entries); index++ {
		if entries[index-1].record.Kind != KindLoss || entries[index].record.Kind != KindSample {
			continue
		}

		sample, err := DecodeSample(entries[index].record)
		if err != nil {
			t.Fatal(err)
		}

		if sample.ElapsedMs != 100 {
			continue
		}

		if entries[index-1].entry.Name != entries[index].entry.Name || entries[index].entry.Boot != (BootID{1}).String() {
			t.Fatalf("deferred loss/sample segments=%+v %+v", entries[index-1].entry, entries[index].entry)
		}

		found = true
	}

	if !found {
		t.Fatal("deferred loss was not immediately before the sample")
	}

	assertNoZeroBootSegmentsForTest(t, opened.Writer)
}

func TestDropWithoutWriterDefersLossToBootlessFirstBatch(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for index := int64(0); index < 12; index++ {
		appendSampleForTest(t, storage, BootID{1}, index)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	limits.Bytes = 400
	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	defer opened.Writer.Close()

	if _, err := opened.Writer.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	publication, err := PreparePublication(Publication{})
	if err != nil {
		t.Fatal(err)
	}

	sample, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: 100, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := opened.Writer.Append(context.Background(), []Record{publication, sample}); err != nil {
		t.Fatal(err)
	}

	entries := scanManifestRecordsForTest(t, opened.Writer)

	if len(entries) < 3 {
		t.Fatalf("records=%+v, want deferred loss, publication and sample", entries)
	}

	tail := entries[len(entries)-3:]

	if tail[0].record.Kind != KindLoss || tail[1].record.Kind != KindPublication || tail[2].record.Kind != KindSample {
		t.Fatalf("tail order=%+v", tail)
	}

	for _, entry := range tail {
		if entry.entry.Name != tail[0].entry.Name || entry.entry.Boot != (BootID{1}).String() {
			t.Fatalf("batch records do not share boot segment: %+v", tail)
		}
	}

	assertNoZeroBootSegmentsForTest(t, opened.Writer)
}

func appendSampleForTest(t *testing.T, storage *Storage, boot BootID, elapsed int64) {
	t.Helper()

	record, err := PrepareSample(Sample{Boot: boot, Series: 1, ElapsedMs: elapsed, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
		t.Fatal(err)
	}
}

type segmentRecordForTest struct {
	entry  SegmentEntry
	record Record
}

func scanManifestRecordsForTest(t *testing.T, storage *Storage) []segmentRecordForTest {
	t.Helper()

	var records []segmentRecordForTest

	for _, entry := range storage.Manifest().Segments {
		if err := scanSegmentFile(storage.fs, filepath.Join(storage.paths.JournalDir, entry.Name), 0, func(record Record) error {
			records = append(records, segmentRecordForTest{entry: entry, record: record})

			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	return records
}

func assertNoZeroBootSegmentsForTest(t *testing.T, storage *Storage) {
	t.Helper()

	for _, entry := range storage.Manifest().Segments {
		if entry.Boot != (BootID{}).String() {
			continue
		}

		if _, err := os.Stat(filepath.Join(storage.paths.JournalDir, entry.Name)); err == nil {
			t.Fatalf("zero-boot segment exists: %s", entry.Name)
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stat zero-boot segment %s: %v", entry.Name, err)
		}

		t.Fatalf("manifest contains zero-boot segment: %+v", entry)
	}
}

func TestMaintainExpiresUnsealedSegmentOfPreviousBoot(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 1 << 20
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot1 := BootID{1}
	now := int64(1800000000000)
	anchor, err := PrepareAnchor(Anchor{Boot: boot1, ClockSegment: 0, UTCMs: now - 40*24*time.Hour.Milliseconds()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
		t.Fatal(err)
	}

	for index := int64(0); index < 3; index++ {
		appendSampleForTest(t, storage, boot1, index)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	appendSampleForTest(t, storage, BootID{2}, 1)

	result, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now})
	if err != nil {
		t.Fatal(err)
	}

	if !result.InventoryChanged {
		t.Fatal("previous-boot expired segment was not evicted")
	}

	if manifestHasBoot(storage.Manifest(), boot1) || !manifestHasBoot(storage.Manifest(), BootID{2}) {
		t.Fatalf("remaining sessions=%+v", storage.Manifest().Segments)
	}

	appendSampleForTest(t, storage, BootID{2}, 2)
	appendSampleForTest(t, storage, BootID{2}, 3)

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	defer opened.Writer.Close()

	if len(opened.Status.Issues) != 0 {
		t.Fatalf("recovery issues=%+v", opened.Status.Issues)
	}

	entries := scanManifestRecordsForTest(t, opened.Writer)
	var lossCount int
	var lossReason LossReason
	var samples []int64

	for _, entry := range entries {
		switch entry.record.Kind {
		case KindLoss:
			loss, err := DecodeLoss(entry.record)
			if err != nil {
				t.Fatal(err)
			}

			lossCount++
			lossReason = loss.Reason
		case KindSample:
			sample, err := DecodeSample(entry.record)
			if err != nil {
				t.Fatal(err)
			}

			if sample.Boot == (BootID{2}) {
				samples = append(samples, sample.ElapsedMs)
			}
		}
	}

	if lossCount != 1 || lossReason != LossAge {
		t.Fatalf("loss count=%d reason=%d, want one age loss", lossCount, lossReason)
	}

	if len(samples) != 3 || samples[0] != 1 || samples[1] != 2 || samples[2] != 3 {
		t.Fatalf("boot-2 samples=%v, want [1 2 3]", samples)
	}

	assertNoZeroBootSegmentsForTest(t, opened.Writer)
}

func TestMaintainBudgetEvictsUnsealedPreviousBoots(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 600
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for _, boot := range []BootID{{1}, {2}, {3}} {
		for elapsed := int64(0); elapsed < 4; elapsed++ {
			appendSampleForTest(t, storage, boot, elapsed)
		}
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	appendSampleForTest(t, storage, BootID{4}, 1)

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if got := journalFileBytes(t, storage, paths); got > limits.Bytes {
		t.Fatalf("journal bytes=%d, budget=%d", got, limits.Bytes)
	}

	if manifestHasBoot(storage.Manifest(), BootID{1}) && manifestHasBoot(storage.Manifest(), BootID{3}) {
		t.Fatalf("oldest boot retained while newer previous boot remains: %+v", storage.Manifest().Segments)
	}

	if !manifestHasBoot(storage.Manifest(), BootID{4}) {
		t.Fatalf("active boot evicted: %+v", storage.Manifest().Segments)
	}
}

func TestMaintainBudgetEvictsWholeAnchoredBoot(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 700
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	base := int64(1800000000000)

	for bootNumber := byte(1); bootNumber <= 4; bootNumber++ {
		boot := BootID{bootNumber}
		anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 0, UTCMs: base + int64(bootNumber)*24*time.Hour.Milliseconds()})
		if err != nil {
			t.Fatal(err)
		}

		if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
			t.Fatal(err)
		}

		for sample := int64(0); sample < 4; sample++ {
			appendSampleForTest(t, storage, boot, sample*3*time.Minute.Milliseconds())
		}
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	now := base + 5*24*time.Hour.Milliseconds()
	result, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now})
	if err != nil {
		t.Fatal(err)
	}

	if !result.InventoryChanged {
		t.Fatal("budget eviction did not report inventory change")
	}

	if got := journalFileBytes(t, storage, storage.paths); got > limits.Bytes {
		t.Fatalf("journal bytes=%d, budget=%d", got, limits.Bytes)
	}

	manifest := storage.Manifest()

	if manifestHasBoot(manifest, BootID{1}) && manifestHasBoot(manifest, BootID{2}) {
		t.Fatalf("oldest boot retained while boot 2 remains: %+v", manifest.Segments)
	}

	if !manifestHasBoot(manifest, BootID{4}) {
		t.Fatalf("active boot evicted: %+v", manifest.Segments)
	}

	anchors := map[string]bool{}
	samples := map[string]bool{}

	if err := storage.Scan(context.Background(), 0, func(record Record) error {
		switch record.Kind {
		case KindAnchor:
			anchor, err := DecodeAnchor(record)
			if err != nil {
				return err
			}

			anchors[anchor.Boot.String()] = true
		case KindSample:
			sample, err := DecodeSample(record)
			if err != nil {
				return err
			}

			samples[sample.Boot.String()] = true
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	for boot := range samples {
		if !anchors[boot] {
			t.Fatalf("boot %s retained samples without anchor", boot)
		}
	}
}

func TestMaintainBudgetKeepsActiveBootAnchor(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	limits.Bytes = 64
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{8}
	now := int64(1800000000000)
	anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 0, UTCMs: now})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
		t.Fatal(err)
	}

	for sample := int64(0); sample < 8; sample++ {
		appendSampleForTest(t, storage, boot, sample*3*time.Minute.Milliseconds())
	}

	segments := storage.Manifest().Segments

	if len(segments) < 2 || storage.active == nil {
		t.Fatalf("fixture did not roll with active writer: %+v", segments)
	}

	anchorSegment := ""

	for _, entry := range segments {
		if err := scanSegmentFile(storage.fs, filepath.Join(storage.paths.JournalDir, entry.Name), 0, func(record Record) error {
			if record.Kind == KindAnchor {
				anchorSegment = entry.Name
			}

			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	if anchorSegment == "" {
		t.Fatal("fixture anchor not found")
	}

	if _, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now}); err != nil {
		t.Fatal(err)
	}

	if !manifestHasSegment(storage.Manifest(), anchorSegment) {
		t.Fatalf("active boot anchor segment %s was evicted: %+v", anchorSegment, storage.Manifest().Segments)
	}

	appendSampleForTest(t, storage, boot, 9*3*time.Minute.Milliseconds())
}

func TestMaintainNeverEvictsActiveSegment(t *testing.T) {
	limits := DefaultLimits()
	limits.Bytes = 64
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{5}
	now := int64(1800000000000)
	anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 0, UTCMs: now - 40*24*time.Hour.Milliseconds()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
		t.Fatal(err)
	}

	for index := int64(0); index < 3; index++ {
		appendSampleForTest(t, storage, boot, index)
	}

	before := storage.Manifest().Segments

	if len(before) != 1 {
		t.Fatalf("setup segments=%+v", before)
	}

	if _, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now}); err != nil {
		t.Fatal(err)
	}

	after := storage.Manifest().Segments

	if len(after) != 1 || after[0].Name != before[0].Name {
		t.Fatalf("active segment changed: before=%+v after=%+v", before, after)
	}

	appendSampleForTest(t, storage, boot, 4)

	if segments := storage.Manifest().Segments; len(segments) != 1 || segments[0].Name != before[0].Name {
		t.Fatalf("append did not continue active segment: %+v", segments)
	}
}

func TestReopenAfterCrashResumesSameBootSegment(t *testing.T) {
	limits := DefaultLimits()
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{6}

	for elapsed := int64(0); elapsed < 3; elapsed++ {
		appendSampleForTest(t, storage, boot, elapsed)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)
	beforeSegments := storage.Manifest().Segments

	if len(beforeSegments) != 1 {
		t.Fatalf("setup segments=%+v", beforeSegments)
	}

	name := beforeSegments[0].Name
	path := filepath.Join(paths.JournalDir, name)
	beforeSize, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	sample, err := PrepareSample(Sample{Boot: boot, Series: 1, ElapsedMs: 3, Values: []Value{{Known: true, V: 3}}})
	if err != nil {
		t.Fatal(err)
	}

	frame, err := EncodeRecord(Record{Kind: sample.Kind, Seq: 1, Payload: sample.Payload})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{sample}); err != nil {
		t.Fatal(err)
	}

	if len(storage.Manifest().Segments) != len(beforeSegments) {
		t.Fatalf("append created another segment: %+v", storage.Manifest().Segments)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if info.Size() != beforeSize.Size()+int64(len(frame)) {
		t.Fatalf("resumed segment size=%d, want %d", info.Size(), beforeSize.Size()+int64(len(frame)))
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	opened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, limits)
	if err != nil {
		t.Fatal(err)
	}

	defer opened.Writer.Close()

	if got := countSamples(t, opened.Writer); got != 4 {
		t.Fatalf("reopened samples=%d, want 4", got)
	}
}

func TestMaintainSessionLimitCountsBootsWithoutBootStart(t *testing.T) {
	limits := DefaultLimits()
	limits.Sessions = 1
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	appendSampleForTest(t, storage, BootID{1}, 1)

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	appendSampleForTest(t, storage, BootID{2}, 1)

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if manifestHasBoot(storage.Manifest(), BootID{1}) || !manifestHasBoot(storage.Manifest(), BootID{2}) {
		t.Fatalf("sessions after limit=%+v", storage.Manifest().Segments)
	}
}

func TestMaintainSessionLimitDropsEverySegmentOfBoot(t *testing.T) {
	limits := DefaultLimits()
	limits.Sessions = 1
	limits.SegmentBytes = 256
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot1 := BootID{1}
	start, err := PrepareBootStart(BootStart{Boot: boot1, FirstAcquireElapsedMs: 0})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{start}); err != nil {
		t.Fatal(err)
	}

	for elapsed := int64(0); elapsed < 8; elapsed++ {
		appendSampleForTest(t, storage, boot1, elapsed)
	}

	if len(storage.Manifest().Segments) < 2 {
		t.Fatalf("setup did not roll segments: %+v", storage.Manifest().Segments)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)
	start, err = PrepareBootStart(BootStart{Boot: BootID{2}, FirstAcquireElapsedMs: 0})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{start}); err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if manifestHasBoot(storage.Manifest(), boot1) || !manifestHasBoot(storage.Manifest(), BootID{2}) {
		t.Fatalf("sessions after limit=%+v", storage.Manifest().Segments)
	}
}

func TestMaintainReportsPinPressureForUnsealedPreviousBoot(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 1 << 20
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	now := int64(1800000000000)
	anchor, err := PrepareAnchor(Anchor{Boot: BootID{1}, ClockSegment: 0, UTCMs: now - 40*24*time.Hour.Milliseconds()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
		t.Fatal(err)
	}

	appendSampleForTest(t, storage, BootID{1}, 0)

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	appendSampleForTest(t, storage, BootID{2}, 1)

	lease, err := storage.Pin(1)
	if err != nil {
		t.Fatal(err)
	}

	defer lease.Close()

	if _, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now}); !errors.Is(err, ErrPinPressure) {
		t.Fatalf("maintenance error=%v, want pin pressure", err)
	}

	if !manifestHasBoot(storage.Manifest(), BootID{1}) {
		t.Fatal("pin pressure dropped the previous-boot segment")
	}
}

func TestMaintainBeforeFirstAppendThenAppend(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 1 << 20
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	now := int64(1800000000000)
	anchor, err := PrepareAnchor(Anchor{Boot: BootID{1}, ClockSegment: 0, UTCMs: now - 40*24*time.Hour.Milliseconds()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{anchor}); err != nil {
		t.Fatal(err)
	}

	appendSampleForTest(t, storage, BootID{1}, 0)

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	if _, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now}); err != nil {
		t.Fatal(err)
	}

	if manifestHasBoot(storage.Manifest(), BootID{1}) {
		t.Fatal("expired boot retained before first append")
	}

	appendSampleForTest(t, storage, BootID{2}, 1)

	if !manifestHasBoot(storage.Manifest(), BootID{2}) {
		t.Fatal("append after maintenance did not create boot-2 segment")
	}

	assertNoZeroBootSegmentsForTest(t, storage)
}

func TestCompactionSealsAndKeepsHeaderBoot(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	now := int64(1800000000000)

	appendCompactionFixture(t, storage, BootID{7}, now)

	if len(storage.Manifest().Segments) != 2 {
		t.Fatalf("fixture segments=%+v, want exactly 2", storage.Manifest().Segments)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage = reopenAfterCrash(t, paths, limits)

	if storage.active != nil {
		t.Fatal("crash reopen unexpectedly opened active writer")
	}

	segments := storage.Manifest().Segments

	if !segments[0].Sealed || segments[1].Sealed {
		t.Fatalf("reopen flags=%+v, want only last segment unsealed", segments)
	}

	storage.mu.Lock()

	storage.retention = RetentionInput{TrustedNowMs: &now}
	scan, _, err := storage.scanRetentionLocked()
	if err != nil {
		storage.mu.Unlock()
		t.Fatal(err)
	}

	compacted, err := storage.compactSegmentLocked(context.Background(), segments[1], scan)

	storage.mu.Unlock()

	if err != nil || !compacted {
		t.Fatalf("compact result=%t err=%v", compacted, err)
	}

	var rewritten SegmentEntry

	for _, entry := range storage.Manifest().Segments {
		if entry.Name == segments[1].Name {
			rewritten = entry
		}
	}

	if !rewritten.Sealed {
		t.Fatalf("rewritten entry remains unsealed: %+v", rewritten)
	}

	file, err := os.Open(filepath.Join(paths.JournalDir, rewritten.Name))
	if err != nil {
		t.Fatal(err)
	}

	header, headerErr := DecodeHeader(file)
	closeErr := file.Close()

	if headerErr != nil {
		t.Fatal(headerErr)
	}

	if closeErr != nil {
		t.Fatal(closeErr)
	}

	if header.Boot != (BootID{7}) {
		t.Fatalf("rewritten header boot=%s", header.Boot)
	}

	before, err := os.Stat(filepath.Join(paths.JournalDir, rewritten.Name))
	if err != nil {
		t.Fatal(err)
	}

	appendSampleForTest(t, storage, BootID{7}, 31*24*time.Hour.Milliseconds())

	if got := len(storage.Manifest().Segments); got != 3 {
		t.Fatalf("segments after append=%d, want new third segment", got)
	}

	after, err := os.Stat(filepath.Join(paths.JournalDir, rewritten.Name))
	if err != nil {
		t.Fatal(err)
	}

	if after.Size() != before.Size() {
		t.Fatalf("rewritten sealed segment changed size: %d -> %d", before.Size(), after.Size())
	}
}

func TestCompactionRefusesActiveSegment(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	now := int64(1800000000000)

	appendCompactionFixture(t, storage, BootID{7}, now)

	segments := storage.Manifest().Segments

	if len(segments) != 2 || storage.active == nil || storage.active.name != segments[1].Name {
		t.Fatalf("fixture active=%+v segments=%+v", storage.active, segments)
	}

	path := filepath.Join(paths.JournalDir, segments[1].Name)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	storage.mu.Lock()

	storage.retention = RetentionInput{TrustedNowMs: &now}
	scan, _, err := storage.scanRetentionLocked()
	if err != nil {
		storage.mu.Unlock()
		t.Fatal(err)
	}

	compacted, err := storage.compactSegmentLocked(context.Background(), segments[1], scan)

	storage.mu.Unlock()

	if err != nil || compacted {
		t.Fatalf("compact active segment result=%t err=%v, want false,nil", compacted, err)
	}

	entry := storage.Manifest().Segments[1]

	if entry.Sealed {
		t.Fatalf("active segment marked sealed: %+v", entry)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if after.Size() != before.Size() {
		t.Fatalf("active segment size changed: %d -> %d", before.Size(), after.Size())
	}

	appendSampleForTest(t, storage, BootID{7}, 32*24*time.Hour.Milliseconds())

	if storage.Manifest().Segments[1].Name != segments[1].Name {
		t.Fatalf("append did not continue active segment: %+v", storage.Manifest().Segments)
	}
}

func appendCompactionFixture(t *testing.T, storage *Storage, boot BootID, now int64) {
	t.Helper()

	start, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 0})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 0, ElapsedMs: 0, UTCMs: now - 40*24*time.Hour.Milliseconds()})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{start, anchor}); err != nil {
		t.Fatal(err)
	}

	for elapsed := int64(0); len(storage.Manifest().Segments) < 2 && elapsed < 20*60*60*1000; elapsed += 15 * 60 * 1000 {
		appendSampleForTest(t, storage, boot, elapsed)
	}

	if len(storage.Manifest().Segments) < 2 {
		t.Fatal("fixture did not roll into a second segment")
	}

	publication, err := PreparePublication(Publication{})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{publication}); err != nil {
		t.Fatal(err)
	}

	appendSampleForTest(t, storage, boot, 30*24*time.Hour.Milliseconds()-time.Hour.Milliseconds())
}

func manifestHasBoot(manifest Manifest, boot BootID) bool {
	for _, entry := range manifest.Segments {
		if entry.Boot == boot.String() {
			return true
		}
	}

	return false
}

func manifestHasSegment(manifest Manifest, name string) bool {
	for _, entry := range manifest.Segments {
		if entry.Name == name {
			return true
		}
	}

	return false
}

func TestMaintainReportsPinPressure(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 150
	limits.Bytes = 64
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for elapsed := int64(0); elapsed < 2; elapsed++ {
		appendSampleForTest(t, storage, BootID{1}, elapsed)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	lease, err := storage.Pin(1)
	if err != nil {
		t.Fatal(err)
	}

	defer lease.Close()

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); !errors.Is(err, ErrPinPressure) {
		t.Fatalf("pin pressure not reported: %v", err)
	}

	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Maintain(context.Background(), RetentionInput{}); errors.Is(err, ErrPinPressure) {
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

	result, err := storage.Maintain(context.Background(), RetentionInput{})
	if err != nil {
		t.Fatal(err)
	}

	if !result.InventoryChanged {
		t.Fatal("session eviction did not report inventory change")
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

func TestCoverageUsesCanonicalFirstAnchor(t *testing.T) {
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})
	boot := BootID{10}
	firstUTC := int64(1800000000000)
	start, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}

	firstAnchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 0, UTCMs: firstUTC})
	if err != nil {
		t.Fatal(err)
	}

	secondAnchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 0, UTCMs: firstUTC + 10_000})
	if err != nil {
		t.Fatal(err)
	}

	sample, err := PrepareSample(Sample{Boot: boot, ClockSegment: 1, Series: 1, ElapsedMs: 1000,
		Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{start, firstAnchor, secondAnchor, sample}); err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	coverage := storage.Coverage()
	want := firstUTC + 1000

	if len(coverage) != 1 || coverage[0].StartMs == nil || *coverage[0].StartMs != want ||
		coverage[0].EndMs == nil || *coverage[0].EndMs != want {
		t.Fatalf("coverage=%+v, want both edges at %d", coverage, want)
	}
}

func TestMaintainPreservesCanonicalAnchorNeededBySurvivingSample(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{11}
	now := int64(1800000000000)
	anchorUTC := now - 40*24*time.Hour.Milliseconds()
	start, err := PrepareBootStart(BootStart{Boot: boot, FirstAcquireElapsedMs: 0})
	if err != nil {
		t.Fatal(err)
	}

	anchor, err := PrepareAnchor(Anchor{Boot: boot, ClockSegment: 1, ElapsedMs: 0, UTCMs: anchorUTC})
	if err != nil {
		t.Fatal(err)
	}

	oldSample, err := PrepareSample(Sample{Boot: boot, ClockSegment: 1, Series: 1, ElapsedMs: 0,
		Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}

	liveSample, err := PrepareSample(Sample{Boot: boot, ClockSegment: 1, Series: 1,
		ElapsedMs: 15 * 24 * time.Hour.Milliseconds(), Values: []Value{{Known: true, V: 2}}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Append(context.Background(), []Record{start, anchor, oldSample, liveSample}); err != nil {
		t.Fatal(err)
	}

	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(storage.Manifest().Segments) < 2 {
		t.Fatalf("expected anchor and later sample in separate segments: %+v", storage.Manifest().Segments)
	}

	result, err := storage.Maintain(context.Background(), RetentionInput{TrustedNowMs: &now})
	if err != nil {
		t.Fatal(err)
	}

	if !result.InventoryChanged {
		t.Fatal("maintenance did not report anchor-segment compaction")
	}

	var gotAnchor bool
	var gotOldSample bool
	var gotLiveSample bool
	var records []Record

	if err := storage.Scan(context.Background(), 0, func(record Record) error {
		records = append(records, record)

		if record.Kind == KindAnchor {
			gotAnchor = true
		}

		if record.Kind == KindSample {
			sample, err := DecodeSample(record)
			if err != nil {
				return err
			}

			gotOldSample = gotOldSample || sample.ElapsedMs == 0
			gotLiveSample = gotLiveSample || sample.ElapsedMs == 15*24*time.Hour.Milliseconds()
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if !gotAnchor || gotOldSample || !gotLiveSample {
		t.Fatalf("retained anchor=%t old sample=%t live sample=%t", gotAnchor, gotOldSample, gotLiveSample)
	}

	index := BuildAnchorIndex(records)

	if _, ok := index.AnchorFor(Sample{Boot: boot, ClockSegment: 1}); !ok {
		t.Fatal("surviving sample lost its canonical anchor")
	}
}

func TestMaintainReportsPartialInventoryChangeWithError(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)
	boot := BootID{12}

	for i := 0; i < 12; i++ {
		record, err := PrepareSample(Sample{Boot: boot, Series: 1, ElapsedMs: int64(i),
			Values: []Value{{Known: true, V: float64(i)}}})
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

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	result, err := storage.Maintain(ctx, RetentionInput{LatestElapsed: map[BootID]int64{
		boot: 40 * 24 * time.Hour.Milliseconds(),
	}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("maintenance error=%v, want context cancellation after mutation", err)
	}

	if !result.InventoryChanged {
		t.Fatal("partial successful drop was not reported")
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
