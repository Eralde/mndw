package rci

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCompactQueriesPreservesFirstSeenWireOrderAndFanOut(t *testing.T) {
	queries := []Query{Q("show.version"), Q("show.system"), Q("show.version")}

	compacted, err := compactQueries(queries)
	if err != nil {
		t.Fatal(err)
	}

	wantWire := []string{
		`{"show":{"version":{}}}`,
		`{"show":{"system":{}}}`,
	}

	if got := rawStrings(compacted.wire); !reflect.DeepEqual(got, wantWire) {
		t.Fatalf("wire = %#v, want %#v", got, wantWire)
	}

	wantPositions := [][]int{{0, 2}, {1}}

	if !reflect.DeepEqual(compacted.positions, wantPositions) {
		t.Fatalf("positions = %#v, want %#v", compacted.positions, wantPositions)
	}

	uniqueResults := []json.RawMessage{json.RawMessage(`"version"`), json.RawMessage(`"system"`)}
	got := inflateResults(uniqueResults, compacted.positions, len(queries))
	want := []json.RawMessage{json.RawMessage(`"version"`), json.RawMessage(`"system"`), json.RawMessage(`"version"`)}

	if !reflect.DeepEqual(got, want) || len(got) != len(queries) {
		t.Fatalf("inflated results = %#v, want %#v", got, want)
	}
}

func TestCompactQueriesDeduplicatesEquivalentWireBytes(t *testing.T) {
	queries := []Query{
		Q("show.version"),
		Q("show.version", map[string]any{}),
		{Path: "show.version", Raw: true},
	}

	compacted, err := compactQueries(queries)
	if err != nil {
		t.Fatal(err)
	}

	if len(compacted.wire) != 1 {
		t.Fatalf("unique wire entries = %d, want 1", len(compacted.wire))
	}

	if want := [][]int{{0, 1, 2}}; !reflect.DeepEqual(compacted.positions, want) {
		t.Fatalf("positions = %#v, want %#v", compacted.positions, want)
	}
}

func TestCompactQueriesUsesStableMapKeyOrdering(t *testing.T) {
	query := Q("show.system", map[string]any{"z": 1, "attribute": "avg", "detail": 0})

	for repetition := 0; repetition < 100; repetition++ {
		compacted, err := compactQueries([]Query{query})
		if err != nil {
			t.Fatal(err)
		}

		if got, want := string(compacted.wire[0]), `{"show":{"system":{"attribute":"avg","detail":0,"z":1}}}`; got != want {
			t.Fatalf("wire = %s, want %s", got, want)
		}
	}
}

func rawStrings(values [][]byte) []string {
	result := make([]string, len(values))

	for index, value := range values {
		result[index] = string(value)
	}

	return result
}
