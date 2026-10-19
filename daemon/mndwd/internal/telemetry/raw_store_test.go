package telemetry

import (
	"math"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

func TestRawStoreDefaultCapacityUsesJournalRetention(t *testing.T) {
	store, err := NewRawStore(journal.DefaultLimits(), DefaultSeriesSpecs())
	if err != nil {
		t.Fatal(err)
	}

	for _, series := range []uint16{1, 2} {
		if got := store.Capacity(series); got != 14400 {
			t.Errorf("Capacity(%d) = %d, want 14400", series, got)
		}
	}
}

func TestRawStoreApplyWraparoundSequenceAndCopiedHalfOpenRead(t *testing.T) {
	step := 3 * time.Minute
	store := newTestRawStore(t, 3*step, SeriesSpec{ID: 1, Step: step, ValueKeys: []string{"cpu", "ram"}})
	base := time.Unix(0, 0).UTC()

	if err := store.Apply(Batch{Updates: []SlotUpdate{
		{Series: 1, Row: Row{Slot: base, Sequence: 1, Values: []Value{{V: 1, Known: true}, {V: 11, Known: true}}}},
		{Series: 1, Row: Row{Slot: base.Add(step), Sequence: 2, Values: []Value{{V: 2, Known: true}, {V: 12, Known: true}}}},
		{Series: 1, Row: Row{Slot: base.Add(2 * step), Sequence: 3, Values: []Value{{V: 3, Known: true}, {V: 13, Known: true}}}},
	}}); err != nil {
		t.Fatal(err)
	}

	// A lower sequence cannot replace the current winner for one slot.
	if err := store.Apply(Batch{Updates: []SlotUpdate{{Series: 1, Row: Row{Slot: base.Add(step), Sequence: 1, Values: []Value{{V: 99, Known: true}, {V: 99, Known: true}}}}}}); err != nil {
		t.Fatal(err)
	}

	// Reapplying the same durable batch is idempotent.
	if err := store.Apply(Batch{Updates: []SlotUpdate{{Series: 1, Row: Row{Slot: base.Add(step), Sequence: 2, Values: []Value{{V: 2, Known: true}, {V: 12, Known: true}}}}}}); err != nil {
		t.Fatal(err)
	}

	// A greater sequence replaces the complete value vector.
	if err := store.Apply(Batch{Updates: []SlotUpdate{{Series: 1, Row: Row{Slot: base.Add(step), Sequence: 5, Values: []Value{{V: 25, Known: true}, {}}}}}}); err != nil {
		t.Fatal(err)
	}

	// The fourth slot reuses the first ring position and evicts its old value.
	if err := store.Apply(Batch{Updates: []SlotUpdate{{Series: 1, Row: Row{Slot: base.Add(3 * step), Sequence: 4, Values: []Value{{V: 4, Known: true}, {V: 14, Known: true}}}}}}); err != nil {
		t.Fatal(err)
	}

	rows, err := store.Read(Query{Series: 1, Start: base.Add(step), End: base.Add(4 * step)})
	if err != nil {
		t.Fatal(err)
	}

	if len(rows) != 3 {
		t.Fatalf("Read returned %d rows, want 3", len(rows))
	}

	if rows[0].Values[0].V != 25 || rows[0].Values[1].Known || rows[1].Values[0].V != 3 || rows[2].Values[0].V != 4 {
		t.Fatalf("Read values = %#v, want winning whole vector then [3 4]", rows)
	}

	if rows[0].Slot != base.Add(step) || rows[2].Slot != base.Add(3*step) {
		t.Fatalf("Read slots = [%s, %s], want [%s, %s]", rows[0].Slot, rows[2].Slot, base.Add(step), base.Add(3*step))
	}

	// Returned rows and value vectors are independent copies.
	rows[0].Values[0].V = 500
	rows[0].Values[0].Known = false
	rowsAgain, err := store.Read(Query{Series: 1, Start: base.Add(step), End: base.Add(4 * step)})
	if err != nil {
		t.Fatal(err)
	}

	if rowsAgain[0].Values[0].V != 25 || !rowsAgain[0].Values[0].Known {
		t.Fatalf("mutating a read changed stored state: %#v", rowsAgain[0])
	}
}

func TestRawStoreReadSynthesizesIndependentUnknownValues(t *testing.T) {
	step := 3 * time.Minute
	store := newTestRawStore(t, 3*step, SeriesSpec{ID: 1, Step: step, ValueKeys: []string{"cpu", "ram"}})
	base := time.Unix(0, 0).UTC()

	if err := store.Apply(Batch{Updates: []SlotUpdate{{
		Series: 1,
		Row:    Row{Slot: base, Sequence: 1, Values: []Value{{V: 10, Known: true}, {}}},
	}}}); err != nil {
		t.Fatal(err)
	}

	rows, err := store.Read(Query{Series: 1, Start: base, End: base.Add(3 * step)})
	if err != nil {
		t.Fatal(err)
	}

	if len(rows) != 3 {
		t.Fatalf("Read returned %d rows, want three including gaps", len(rows))
	}

	if !rows[0].Values[0].Known || rows[0].Values[0].V != 10 || rows[0].Values[1].Known {
		t.Fatalf("first row values = %#v, want known CPU and unknown RAM", rows[0].Values)
	}

	for _, row := range rows[1:] {
		if len(row.Values) != 2 || row.Values[0].Known || row.Values[1].Known {
			t.Fatalf("gap row is not synthesized as independent unknown values: %#v", row)
		}
	}

	if rows[2].Slot != base.Add(2*step) {
		t.Fatalf("exclusive end included wrong slot: %s", rows[2].Slot)
	}
}

func TestRawStoreReplaceIsAtomicAndBounds(t *testing.T) {
	step := 3 * time.Minute
	store := newTestRawStore(t, 4*step, SeriesSpec{ID: 1, Step: step, ValueKeys: []string{"load"}})
	base := time.Unix(0, 0).UTC()

	if from, to, ok := store.Bounds(1); ok || !from.IsZero() || !to.IsZero() {
		t.Fatalf("empty Bounds = (%s, %s, %v), want zero false", from, to, ok)
	}

	want := State{Rows: map[uint16][]Row{1: {rawTestRow(base, 7, 17), rawTestRow(base.Add(step), 8, 18)}}}

	if err := store.Replace(want); err != nil {
		t.Fatal(err)
	}

	from, to, ok := store.Bounds(1)

	if !ok || !from.Equal(base) || !to.Equal(base.Add(step)) {
		t.Fatalf("Bounds = (%s, %s, %v), want (%s, %s, true)", from, to, ok, base, base.Add(step))
	}

	bad := State{Rows: map[uint16][]Row{1: {rawTestRow(base, 9, 19)}, 99: {rawTestRow(base, 10, 20)}}}

	if err := store.Replace(bad); err == nil {
		t.Fatal("Replace accepted an unknown series")
	}

	rows, err := store.Read(Query{Series: 1, Start: base, End: base.Add(2 * step)})
	if err != nil {
		t.Fatal(err)
	}

	if len(rows) != 2 || rows[0].Sequence != 7 || rows[1].Sequence != 8 {
		t.Fatalf("failed Replace changed prior state: %#v", rows)
	}

	if err := store.Replace(State{}); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := store.Bounds(1); ok {
		t.Fatal("Bounds reports data after empty Replace")
	}
}

func TestRawStoreRejectsInvalidAndNonFiniteUpdates(t *testing.T) {
	step := 3 * time.Minute
	store := newTestRawStore(t, 2*step, SeriesSpec{ID: 1, Step: step, ValueKeys: []string{"load"}})
	base := time.Unix(0, 0).UTC()

	if err := store.Apply(Batch{Updates: []SlotUpdate{{
		Series: 1,
		Row:    Row{Slot: base, Sequence: 1, Values: []Value{{V: math.NaN(), Known: true}}},
	}}}); err != nil {
		t.Fatal(err)
	}

	rows, err := store.Read(Query{Series: 1, Start: base, End: base.Add(step)})
	if err != nil {
		t.Fatal(err)
	}

	if rows[0].Values[0].Known {
		t.Fatalf("non-finite known value was not made unknown: %#v", rows[0].Values[0])
	}
}

func newTestRawStore(t *testing.T, retention time.Duration, specs ...SeriesSpec) *RawStore {
	t.Helper()

	limits := journal.DefaultLimits()
	limits.Retention = retention
	store, err := NewRawStore(limits, specs)
	if err != nil {
		t.Fatal(err)
	}

	return store
}

func rawTestRow(slot time.Time, sequence uint64, value float64) Row {
	return Row{Slot: slot, Sequence: sequence, Values: []Value{{V: value, Known: true}}}
}
