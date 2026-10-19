package telemetry

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

type historyTestReader struct {
	records    []journal.Record
	err        error
	scanCalls  int
	rangeCalls int
	failOnScan int
}

func (r *historyTestReader) Scan(ctx context.Context, visit func(journal.Record) error) error {
	r.scanCalls++

	for _, record := range r.records {
		if err := ctx.Err(); err != nil {
			return err
		}

		if err := visit(record); err != nil {
			return err
		}
	}

	if r.scanCalls == r.failOnScan {
		return errors.New("configured scan failure")
	}

	return r.err
}

func (r *historyTestReader) ScanAfter(
	ctx context.Context,
	after uint64,
	through uint64,
	visit func(journal.Record) error,
) error {
	r.rangeCalls++

	for _, record := range r.records {
		if err := ctx.Err(); err != nil {
			return err
		}

		if record.Seq <= after || record.Seq > through {
			continue
		}

		if err := visit(record); err != nil {
			return err
		}
	}

	return nil
}

type historyTestWriter struct {
	durable     uint64
	syncThrough uint64
	syncErr     error
	pinErr      error
	pinned      []uint64
	syncCalls   int
}

func (w *historyTestWriter) Sync(context.Context) (uint64, error) {
	w.syncCalls++

	if w.syncErr != nil {
		return w.durable, w.syncErr
	}

	if w.syncThrough != 0 {
		w.durable = w.syncThrough
	}

	return w.durable, nil
}

func (w *historyTestWriter) DurableThrough() uint64 { return w.durable }

func (w *historyTestWriter) Pin(through uint64) (*journal.Lease, error) {
	w.pinned = append(w.pinned, through)

	return nil, w.pinErr
}

func TestHistoryRestoreWritableSyncsPinsAndAtomicallyPublishes(t *testing.T) {
	boot := reducerBoot(21)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 43_000}}})
	reader := &historyTestReader{records: []journal.Record{anchor, sample}}
	writer := &historyTestWriter{syncThrough: 2}
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReady, reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if writer.syncCalls != 1 || !reflect.DeepEqual(writer.pinned, []uint64{2}) {
		t.Fatalf("startup durability calls=%d pins=%v, want one sync and pin at 2", writer.syncCalls, writer.pinned)
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("applied through=%d, want 2", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 43_000)
}

func TestHistoryRestoreReadOnlyUsesValidatedEndWithoutMutation(t *testing.T) {
	boot := reducerBoot(22)
	anchor := reducerAnchorRecord(t, 5, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 8, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 44_000}}})
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{records: []journal.Record{anchor, sample}}, nil, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 8 {
		t.Fatalf("read-only applied through=%d, want validated end 8", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 44_000)
}

func TestHistoryUnavailablePublishesEmptyState(t *testing.T) {
	history := newTestHistory(t)
	boot := reducerBoot(23)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 45_000}}})

	if err := history.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{records: []journal.Record{anchor, sample}}, nil, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if err := history.restore(context.Background(), journal.StatusUnavailable, nil, nil, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 0 {
		t.Fatalf("unavailable applied through=%d, want 0", history.AppliedThrough())
	}

	rows, err := history.Read(Query{Series: 2, Start: time.UnixMilli(1_800_000_000_000).UTC(), End: time.UnixMilli(1_800_000_180_000).UTC()})
	if err != nil || len(rows) != 1 || rows[0].Values[0].Known {
		t.Fatalf("unavailable rows=%#v err=%v, want one unknown slot", rows, err)
	}
}

func TestHistoryRestoreFailureKeepsPreviousPublishedState(t *testing.T) {
	history := newTestHistory(t)
	boot := reducerBoot(24)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 46_000}}})

	if err := history.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{records: []journal.Record{anchor, sample}}, nil, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	badSample := journal.Record{Kind: journal.KindSample, Seq: 3, Payload: []byte{1}}

	if err := history.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{records: []journal.Record{anchor, badSample}}, nil, journal.RetentionInput{}); err == nil {
		t.Fatal("malformed replay succeeded")
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("failed restore advanced through to %d", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 46_000)
}

func TestHistoryLiveApplyWaitsForDurableBoundary(t *testing.T) {
	boot := reducerBoot(25)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 47_000}}})
	reader := &historyTestReader{records: []journal.Record{anchor, sample}}
	writer := &historyTestWriter{durable: 1}
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReady, reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	// Simulate an append that is present in the reader but is not synchronized.
	reader.records = []journal.Record{anchor, sample}

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 1 {
		t.Fatalf("unsynced apply advanced through=%d, want 1", history.AppliedThrough())
	}

	assertHistoryUnknown(t, history, 1_800_000_000_000)

	writer.durable = 2

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("synced apply advanced through=%d, want 2", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 47_000)
}

func TestHistoryLiveApplyFailureKeepsStoreAndAppliedThrough(t *testing.T) {
	boot := reducerBoot(26)
	anchor := reducerAnchorRecord(t, 1, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	sample := reducerSampleRecord(t, 2, journal.Sample{Boot: boot, ClockSegment: 0, Series: 2, Values: []journal.Value{{Known: true, V: 48_000}}})
	reader := &historyTestReader{records: []journal.Record{anchor, sample}}
	writer := &historyTestWriter{syncThrough: 2}
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReady, reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	badSample := journal.Record{Kind: journal.KindSample, Seq: 3, Payload: []byte{2}}
	reader.records = []journal.Record{anchor, sample, badSample}
	writer.durable = 3

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err == nil {
		t.Fatal("malformed live batch succeeded")
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("failed live apply advanced through=%d, want 2", history.AppliedThrough())
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 48_000)
}

func TestHistoryLiveAndStartupReplayConvergeThroughSameBoundary(t *testing.T) {
	bootA := reducerBoot(27)
	bootB := reducerBoot(28)
	anchorA := reducerAnchorRecord(t, 1, journal.Anchor{Boot: bootA, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	transition := reducerTransitionRecord(t, 2, journal.ClockTransition{Boot: bootA, ClockSegment: 0, State: journal.StateAnchored})
	first := reducerSampleRecord(t, 3, journal.Sample{Boot: bootA, ClockSegment: 0, Series: 1, Values: []journal.Value{{Known: true, V: 10}, {}}})
	bootStart := reducerBootStartRecord(t, 4, journal.BootStart{Boot: bootB})
	anchorB := reducerAnchorRecord(t, 5, journal.Anchor{Boot: bootB, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	winner := reducerSampleRecord(t, 6, journal.Sample{Boot: bootB, ClockSegment: 0, Series: 1, Values: []journal.Value{{Known: true, V: 20}, {Known: true, V: 30}}})
	unknown := reducerSampleRecord(t, 7, journal.Sample{Boot: bootB, ClockSegment: 0, Series: 2, Values: []journal.Value{{}}})
	all := []journal.Record{anchorA, transition, first, bootStart, anchorB, winner, unknown}

	live := newTestHistory(t)
	liveWriter := &historyTestWriter{syncThrough: 3}

	if err := live.restore(context.Background(), journal.StatusReady, &historyTestReader{records: all[:3]}, liveWriter, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	liveWriter.durable = 7

	if err := live.applyDurable(context.Background(), &historyTestReader{records: all}, liveWriter, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	startup := newTestHistory(t)

	if err := startup.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{records: all}, nil, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if live.AppliedThrough() != 7 || startup.AppliedThrough() != 7 {
		t.Fatalf("live/startup through=%d/%d, want 7", live.AppliedThrough(), startup.AppliedThrough())
	}

	for _, query := range []Query{
		{Series: 1, Start: time.UnixMilli(1_800_000_000_000).UTC(), End: time.UnixMilli(1_800_000_180_000).UTC()},
		{Series: 2, Start: time.UnixMilli(1_800_000_000_000).UTC(), End: time.UnixMilli(1_800_000_180_000).UTC()},
	} {
		liveRows, err := live.Read(query)
		if err != nil {
			t.Fatal(err)
		}

		startupRows, err := startup.Read(query)
		if err != nil {
			t.Fatal(err)
		}

		if !reflect.DeepEqual(liveRows, startupRows) {
			t.Fatalf("live/startup rows differ for series %d: %#v != %#v", query.Series, liveRows, startupRows)
		}
	}
}

func TestHistoryReplaysPendingSegmentOnceOnFirstAnchor(t *testing.T) {
	boot := reducerBoot(29)
	sample := reducerSampleRecord(t, 1, journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2,
		Values: []journal.Value{{Known: true, V: 49_000}},
	})
	reader := &historyTestReader{records: []journal.Record{sample}}
	writer := &historyTestWriter{durable: 1}
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReady, reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	key := journal.SegmentKey{Boot: boot, ClockSegment: 0}

	if _, ok := history.pending[key]; !ok {
		t.Fatalf("startup pending=%v, want segment key", history.pending)
	}

	assertHistoryUnknown(t, history, 1_800_000_000_000)

	anchor := reducerAnchorRecord(t, 2, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	reader.records = []journal.Record{sample, anchor}
	writer.durable = 2

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("first-anchor applied through=%d, want 2", history.AppliedThrough())
	}

	if _, ok := history.pending[key]; ok {
		t.Fatalf("pending segment survived successful replay: %v", history.pending)
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 49_000)

	secondAnchor := reducerAnchorRecord(t, 3, journal.Anchor{
		Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_180_000,
	})
	reader.records = []journal.Record{sample, anchor, secondAnchor}
	writer.durable = 3

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if reader.scanCalls != 2 || reader.rangeCalls != 2 {
		t.Fatalf("reader scans=(full %d, range %d), want startup + one pending replay and two incremental scans", reader.scanCalls, reader.rangeCalls)
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 49_000)

	rows, err := history.Read(Query{
		Series: 2,
		Start:  time.UnixMilli(1_800_000_180_000).UTC(),
		End:    time.UnixMilli(1_800_000_360_000).UTC(),
	})
	if err != nil || len(rows) != 1 || rows[0].Values[0].Known {
		t.Fatalf("repeated anchor moved sample to another slot: rows=%#v err=%v", rows, err)
	}
}

func TestHistoryPendingReplayScanFailureKeepsKeyAndRetries(t *testing.T) {
	boot := reducerBoot(30)
	sample := reducerSampleRecord(t, 1, journal.Sample{
		Boot: boot, ClockSegment: 0, Series: 2,
		Values: []journal.Value{{Known: true, V: 50_000}},
	})
	anchor := reducerAnchorRecord(t, 2, journal.Anchor{Boot: boot, ClockSegment: 0, UTCMs: 1_800_000_000_000})
	reader := &historyTestReader{records: []journal.Record{sample}}
	writer := &historyTestWriter{durable: 1}
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReady, reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	reader.records = []journal.Record{sample, anchor}
	reader.failOnScan = 2 // startup, then pending sample replay after incremental scan
	writer.durable = 2

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err == nil {
		t.Fatal("pending replay scan failure was ignored")
	}

	key := journal.SegmentKey{Boot: boot, ClockSegment: 0}

	if history.AppliedThrough() != 1 {
		t.Fatalf("failed replay advanced through=%d, want 1", history.AppliedThrough())
	}

	if _, ok := history.pending[key]; !ok {
		t.Fatalf("failed replay cleared pending key: %v", history.pending)
	}

	assertHistoryUnknown(t, history, 1_800_000_000_000)

	reader.failOnScan = 0

	if err := history.applyDurable(context.Background(), reader, writer, journal.RetentionInput{}); err != nil {
		t.Fatal(err)
	}

	if history.AppliedThrough() != 2 {
		t.Fatalf("retried replay applied through=%d, want 2", history.AppliedThrough())
	}

	if _, ok := history.pending[key]; ok {
		t.Fatalf("successful retry kept pending key: %v", history.pending)
	}

	assertHistoryValue(t, history, 1_800_000_000_000, 50_000)
}

func newTestHistory(t *testing.T) *History {
	t.Helper()

	limits := journal.DefaultLimits()
	limits.Retention = 24 * time.Hour
	history, err := NewHistory(limits, DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	return history
}

func assertHistoryValue(t *testing.T, history *History, slotMs int64, want float64) {
	t.Helper()

	rows, err := history.Read(Query{Series: 2, Start: time.UnixMilli(slotMs).UTC(), End: time.UnixMilli(slotMs + 180_000).UTC()})
	if err != nil || len(rows) != 1 || !rows[0].Values[0].Known || rows[0].Values[0].V != want {
		t.Fatalf("history rows=%#v err=%v, want value %v", rows, err, want)
	}
}

func assertHistoryUnknown(t *testing.T, history *History, slotMs int64) {
	t.Helper()

	rows, err := history.Read(Query{Series: 2, Start: time.UnixMilli(slotMs).UTC(), End: time.UnixMilli(slotMs + 180_000).UTC()})
	if err != nil || len(rows) != 1 || rows[0].Values[0].Known {
		t.Fatalf("history rows=%#v err=%v, want unknown slot", rows, err)
	}
}

func TestHistoryPropagatesReaderAndSyncFailures(t *testing.T) {
	history := newTestHistory(t)

	if err := history.restore(context.Background(), journal.StatusReadOnly, &historyTestReader{err: errors.New("scan failed")}, nil, journal.RetentionInput{}); err == nil {
		t.Fatal("reader failure was ignored")
	}

	writer := &historyTestWriter{durable: 4, syncThrough: 5, syncErr: errors.New("sync failed")}

	if err := history.restore(context.Background(), journal.StatusReady, &historyTestReader{}, writer, journal.RetentionInput{}); err == nil {
		t.Fatal("sync failure was ignored")
	}

	if history.AppliedThrough() != 0 {
		t.Fatalf("failed startup advanced through=%d", history.AppliedThrough())
	}
}
