package telemetry

import (
	"testing"
	"time"

	"mndwd/internal/telemetry/clock"
	"mndwd/internal/telemetry/journal"
)

func TestExpectedSlotUsesLatestSyncedAcquisition(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 0, UTCMs: 1800000000000}
	slot, ok := ExpectedSlot(1800000, 180000, 3*time.Minute, 3*time.Minute, 3*time.Minute, anchor)

	if !ok {
		t.Fatal("no expected slot")
	}

	// The newest acquisition whose sync deadline elapsed by the cutoff is
	// 1,620,000 ms of boot time.
	if want := clock.AlignSlot(1800001620000, 3*time.Minute); slot != want {
		t.Fatalf("slot=%d want=%d", slot, want)
	}
}

func TestExpectedSlotRejectsUnsyncedAndUnmappable(t *testing.T) {
	anchor := journal.Anchor{Boot: journal.BootID{1}, ElapsedMs: 0, UTCMs: 1800000000000}

	if _, ok := ExpectedSlot(1000, 180000, 3*time.Minute, 3*time.Minute, 3*time.Minute, anchor); ok {
		t.Fatal("expected slot before the first acquisition")
	}

	if _, ok := ExpectedSlot(1800000, 180000, 0, 3*time.Minute, 3*time.Minute, anchor); ok {
		t.Fatal("zero acquisition interval accepted")
	}

	if _, ok := ExpectedSlot(1800000, 180000, 3*time.Minute, 3*time.Minute, 0, anchor); ok {
		t.Fatal("zero tier accepted")
	}
}

func TestClockMetadataReportsHistoryEndAndFreshness(t *testing.T) {
	end := int64(1800000000000)
	metadata := clockMetadata(clock.Anchored, &end, true, false)

	if metadata.State != "anchored" || metadata.HistoryEndMs == nil || *metadata.HistoryEndMs != end {
		t.Fatalf("metadata=%+v", metadata)
	}

	if !metadata.HistoryCurrent || metadata.ReplayPending {
		t.Fatalf("metadata=%+v", metadata)
	}

	unknown := clockMetadata(clock.Unanchored, nil, false, true)

	if unknown.HistoryEndMs != nil || unknown.HistoryCurrent || !unknown.ReplayPending {
		t.Fatalf("metadata=%+v", unknown)
	}
}
