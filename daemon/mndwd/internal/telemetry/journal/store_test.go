package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func openTestStorage(t *testing.T, fs FileSystem, locker Locker, limits Limits) (*Storage, StoragePaths) {
	t.Helper()
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if limits.Bytes == 0 {
		limits = DefaultLimits()
	}
	opened, err := OpenStorage(context.Background(), paths, fs, locker, limits)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != StatusReady || opened.Writer == nil {
		t.Fatalf("unexpected recovery: %+v", opened.Status)
	}
	t.Cleanup(func() { _ = opened.Writer.Close() })
	return opened.Writer, paths
}

func TestAppendIsNotDurableUntilSync(t *testing.T) {
	fs := newCrashFS(t)
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	opened, err := OpenStorage(context.Background(), paths, fs, &fakeLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if opened.Status.Mode != "ready" || opened.Writer == nil {
		t.Fatalf("unexpected recovery: %+v", opened.Status)
	}
	storage := opened.Writer
	defer storage.Close()

	start, err := PrepareBootStart(BootStart{Boot: BootID{1}, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{start}); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, err := PrepareSample(Sample{Boot: BootID{1}, ClockSegment: 1, Series: 1, ElapsedMs: 180000,
		Values: []Value{{Known: true, V: 20}, {Known: true, V: 40}}})
	if err != nil {
		t.Fatal(err)
	}
	appended, err := storage.Append(context.Background(), []Record{record})
	if err != nil {
		t.Fatal(err)
	}
	if appended.Accepted != 1 {
		t.Fatal("sample not accepted")
	}
	if storage.DurableThrough() >= appended.LastSequence {
		t.Fatal("append falsely reported durable")
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if storage.DurableThrough() != appended.LastSequence {
		t.Fatal("sync did not advance durable prefix")
	}
}

func TestAppendValidatesWholeBatchBeforeWriting(t *testing.T) {
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})

	valid, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	assigned := valid
	assigned.Seq = 9

	result, err := storage.Append(context.Background(), []Record{valid, assigned})
	if err == nil {
		t.Fatalf("accepted an already-assigned sequence: %+v", result)
	}
	if result.Accepted != 0 || result.FirstSequence != 0 || result.LastSequence != 0 {
		t.Fatalf("validation error accepted records: %+v", result)
	}

	accepted, err := storage.Append(context.Background(), []Record{valid})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.FirstSequence != 1 {
		t.Fatalf("sequence allocation reused or skipped: %+v", accepted)
	}
}

func TestAppendReservesSequenceBlocksAndAbandonsRemainder(t *testing.T) {
	paths, err := PathsFromRRDDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	record, err := PrepareBootStart(BootStart{Boot: BootID{1}, FirstAcquireElapsedMs: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Writer.Append(context.Background(), []Record{record}); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := first.Writer.Manifest().ReservedThrough; got != reservationBlock {
		t.Fatalf("reservedThrough=%d", got)
	}
	if err := first.Writer.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Writer.Close()
	next, err := second.Writer.Append(context.Background(), []Record{record})
	if err != nil {
		t.Fatal(err)
	}
	if next.FirstSequence != reservationBlock+1 {
		t.Fatalf("restart reused reserved identities: %+v", next)
	}
}

func TestAppendAcceptsPrefixAndRequiresRepairAfterPartialWrite(t *testing.T) {
	fs := newCrashFS(t)
	storage, _ := openTestStorage(t, fs, &fakeLocker{}, Limits{})

	// Establish the segment first so the failpoint targets record writes only.
	bootStart, err := PrepareBootStart(BootStart{Boot: BootID{1}, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{bootStart}); err != nil {
		t.Fatal(err)
	}

	records := make([]Record, 0, 3)
	for i := 0; i < 3; i++ {
		prepared, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: float64(i)}}})
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, prepared)
	}

	// Allow exactly one record write, then fail.
	fs.FailAfter("write", fs.CountOf("write")+1)
	result, err := storage.Append(context.Background(), records)
	if err == nil {
		t.Fatalf("partial write accepted: %+v", result)
	}
	if result.Accepted != 1 || !result.NeedsRepair {
		t.Fatalf("partial write result=%+v", result)
	}

	if _, err := storage.Append(context.Background(), records[1:]); !errors.Is(err, ErrNeedsRepair) {
		t.Fatalf("append after torn tail: %v", err)
	}
	fs.Disarm("write")
	if err := storage.RepairTail(context.Background()); err != nil {
		t.Fatal(err)
	}
	retried, err := storage.Append(context.Background(), records[1:])
	if err != nil {
		t.Fatal(err)
	}
	if retried.Accepted != 2 {
		t.Fatalf("retry after repair accepted %d", retried.Accepted)
	}

	seen := 0
	if err := storage.Scan(context.Background(), 0, func(Record) error {
		seen++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if seen != 4 {
		t.Fatalf("scan returned %d records", seen)
	}
}

func TestSyncFailureKeepsDurableWatermark(t *testing.T) {
	fs := newCrashFS(t)
	storage, _ := openTestStorage(t, fs, &fakeLocker{}, Limits{})

	record, err := PrepareBootStart(BootStart{Boot: BootID{1}, FirstAcquireElapsedMs: 1})
	if err != nil {
		t.Fatal(err)
	}
	appended, err := storage.Append(context.Background(), []Record{record})
	if err != nil {
		t.Fatal(err)
	}

	fs.FailAfter("syncdir", fs.CountOf("syncdir"))
	if _, err := storage.Sync(context.Background()); err == nil {
		t.Fatal("sync failure accepted")
	}
	if storage.DurableThrough() != 0 {
		t.Fatalf("failed sync advanced durability to %d", storage.DurableThrough())
	}

	fs.Disarm("syncdir")
	if durable, err := storage.Sync(context.Background()); err != nil || durable != appended.LastSequence {
		t.Fatalf("retry sync=%d err=%v", durable, err)
	}
}

func TestAppendRollsSegmentAtCap(t *testing.T) {
	limits := DefaultLimits()
	limits.SegmentBytes = 256
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, limits)

	for i := 0; i < 6; i++ {
		record, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
			t.Fatal(err)
		}
	}
	manifest := storage.Manifest()
	if len(manifest.Segments) < 2 {
		t.Fatalf("segments=%d", len(manifest.Segments))
	}
	for _, entry := range manifest.Segments {
		if entry.Bytes > limits.SegmentBytes {
			t.Fatalf("segment %s is %d bytes", entry.Name, entry.Bytes)
		}
	}
}

func TestAppendSealsSegmentOnBootChange(t *testing.T) {
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})

	for _, boot := range []BootID{{1}, {2}} {
		record, err := PrepareSample(Sample{Boot: boot, Series: 1, Values: []Value{{Known: true, V: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := storage.Append(context.Background(), []Record{record}); err != nil {
			t.Fatal(err)
		}
	}
	segments := storage.Manifest().Segments
	if len(segments) != 2 {
		t.Fatalf("segments=%d", len(segments))
	}
	if !segments[0].Sealed {
		t.Fatal("previous boot segment was not sealed")
	}
	if segments[0].Boot == segments[1].Boot {
		t.Fatal("boots share a segment")
	}
}

func TestSyncedRecordsSurviveCrashAndUnsyncedMayNot(t *testing.T) {
	fs := newCrashFS(t)
	storage, paths := openTestStorage(t, fs, &fakeLocker{}, Limits{})

	durable, err := PrepareBootStart(BootStart{Boot: BootID{1}, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{durable}); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}

	unsynced, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, Values: []Value{{Known: true, V: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(context.Background(), []Record{unsynced}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	fs.Crash()

	reopened, err := OpenStorage(context.Background(), paths, fs, &fakeLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status.Mode != StatusReady {
		t.Fatalf("reopen after crash=%+v", reopened.Status)
	}
	defer reopened.Writer.Close()

	var kinds []Kind
	if err := reopened.Writer.Scan(context.Background(), 0, func(record Record) error {
		kinds = append(kinds, record.Kind)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(kinds) == 0 || kinds[0] != KindBootStart {
		t.Fatalf("synced record did not survive: %v", kinds)
	}
}

func TestScanStopsAtThrough(t *testing.T) {
	storage, _ := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})

	var last uint64
	for i := 0; i < 3; i++ {
		record, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		result, err := storage.Append(context.Background(), []Record{record})
		if err != nil {
			t.Fatal(err)
		}
		last = result.LastSequence
	}

	seen := 0
	if err := storage.Scan(context.Background(), last-1, func(Record) error {
		seen++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if seen != 2 {
		t.Fatalf("scan through %d returned %d records", last-1, seen)
	}
}

func TestRecoveryQuarantinesInteriorCorruption(t *testing.T) {
	storage, paths := openTestStorage(t, OSFileSystem{}, OSLocker{}, Limits{})

	for i := 0; i < 3; i++ {
		record, err := PrepareSample(Sample{Boot: BootID{1}, Series: 1, ElapsedMs: int64(i), Values: []Value{{Known: true, V: 1}}})
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
	segmentName := storage.Manifest().Segments[0].Name
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	segmentPath := filepath.Join(paths.JournalDir, segmentName)
	raw, err := os.ReadFile(segmentPath)
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt a byte inside the first record body, not the tail.
	raw[headerBytes+20] ^= 0xff
	if err := os.WriteFile(segmentPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStorage(context.Background(), paths, OSFileSystem{}, OSLocker{}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Writer.Close()
	if reopened.Status.Mode != StatusReady {
		t.Fatalf("reopen=%+v", reopened.Status)
	}
	found := false
	for _, issue := range reopened.Status.Issues {
		if issue.Code == issueSegmentDamaged {
			found = true
		}
	}
	if !found {
		t.Fatalf("interior corruption not reported: %+v", reopened.Status.Issues)
	}
	if _, err := os.Stat(filepath.Join(paths.JournalDir, quarantinePrefix+segmentName)); err != nil {
		t.Fatalf("damaged segment not quarantined: %v", err)
	}
}
