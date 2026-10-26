package ring

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func TestSystemSchemaSizes(t *testing.T) {
	for _, kind := range []Kind{KindHistory, KindPending} {
		schema := SystemSchema(kind)

		if got := schema.RowSize(); got != 20 {
			t.Errorf("RowSize() = %d, want 20", got)
		}

		if got, want := schema.FileSize(), int64(HeaderSize+14400*20); got != want {
			t.Errorf("FileSize() = %d, want %d", got, want)
		}
	}
}

func TestHeaderRoundTrip(t *testing.T) {
	for _, kind := range []Kind{KindHistory, KindPending} {
		want := SystemSchema(kind)
		encoded, err := EncodeHeader(want)
		if err != nil {
			t.Fatalf("EncodeHeader(%v): %v", kind, err)
		}

		if len(encoded) != HeaderSize {
			t.Fatalf("encoded header size = %d, want %d", len(encoded), HeaderSize)
		}

		got, err := DecodeHeader(encoded)
		if err != nil {
			t.Fatalf("DecodeHeader(%v): %v", kind, err)
		}

		if !got.Equal(want) {
			t.Errorf("decoded schema = %#v, want %#v", got, want)
		}
	}
}

func TestDecodeHeaderRejectsCorruption(t *testing.T) {
	valid, err := EncodeHeader(SystemSchema(KindHistory))
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		mutate func([]byte)
	}{
		{name: "magic", mutate: func(header []byte) { header[0] ^= 0xff }},
		{name: "crc", mutate: func(header []byte) { header[62] ^= 0xff }},
		{name: "version", mutate: func(header []byte) { binary.LittleEndian.PutUint16(header[8:10], 2) }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			corrupt := append([]byte(nil), valid...)

			test.mutate(corrupt)

			if _, err := DecodeHeader(corrupt); !errors.Is(err, ErrInvalidHeader) {
				t.Fatalf("DecodeHeader(corrupt) error = %v, want ErrInvalidHeader", err)
			}
		})
	}
}

func TestSchemaEqualDetectsEachField(t *testing.T) {
	base := SystemSchema(KindHistory)

	if !base.Equal(cloneTestSchema(base)) {
		t.Fatal("schema should equal an identical copy")
	}

	tests := []struct {
		name   string
		mutate func(*Schema)
	}{
		{name: "kind", mutate: func(schema *Schema) { schema.Kind = KindPending }},
		{name: "step", mutate: func(schema *Schema) { schema.StepMs++ }},
		{name: "capacity", mutate: func(schema *Schema) { schema.Capacity++ }},
		{name: "name", mutate: func(schema *Schema) { schema.Values[0].Name = "load" }},
		{name: "unit", mutate: func(schema *Schema) { schema.Values[0].Unit = "ratio" }},
		{name: "count", mutate: func(schema *Schema) { schema.Values = append(schema.Values, ValueSpec{Name: "fan", Unit: "rpm"}) }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			other := cloneTestSchema(base)

			test.mutate(&other)

			if base.Equal(other) {
				t.Fatal("different schemas compare equal")
			}
		})
	}
}

func TestRowRoundTrip(t *testing.T) {
	schema := SystemSchema(KindHistory)
	slot := int64(9_999_999)
	want := []float32{12.5, float32(math.NaN()), 42_000}

	encoded := EncodeRow(schema, slot, want)
	got, ok := DecodeRow(schema, encoded, slot)

	if !ok {
		t.Fatal("DecodeRow rejected a valid row")
	}

	if len(got) != len(want) {
		t.Fatalf("decoded value count = %d, want %d", len(got), len(want))
	}

	for index := range want {
		if math.IsNaN(float64(want[index])) {
			if !math.IsNaN(float64(got[index])) {
				t.Errorf("decoded value %d = %v, want NaN", index, got[index])
			}

			continue
		}

		if got[index] != want[index] {
			t.Errorf("decoded value %d = %v, want %v", index, got[index], want[index])
		}
	}
}

func TestDecodeRowRejects(t *testing.T) {
	schema := SystemSchema(KindHistory)
	slot := int64(9_999_999)
	valid := EncodeRow(schema, slot, []float32{12.5, 40, 42_000})
	zero := make([]byte, schema.RowSize())
	keyZero := EncodeRow(schema, -1, []float32{12.5, 40, 42_000})
	badCRC := append([]byte(nil), valid...)
	badCRC[len(badCRC)-1] ^= 0xff

	tests := []struct {
		name string
		row  []byte
		slot int64
	}{
		{name: "all-zero", row: zero, slot: 0},
		{name: "key-zero", row: keyZero, slot: -1},
		{name: "crc", row: badCRC, slot: slot},
		{name: "stale-position", row: valid, slot: slot + 14400},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := DecodeRow(schema, test.row, test.slot); ok {
				t.Fatal("DecodeRow accepted an invalid row")
			}
		})
	}
}

func TestToFloat64ShortestDecimal(t *testing.T) {
	if got := ToFloat64(float32(37.8)); got != 37.8 {
		t.Errorf("ToFloat64(37.8) = %.17g, want 37.8", got)
	}

	if got := ToFloat64(float32(42_000)); got != 42_000 {
		t.Errorf("ToFloat64(42000) = %.17g, want 42000", got)
	}

	if got := ToFloat64(float32(math.NaN())); !math.IsNaN(got) {
		t.Errorf("ToFloat64(NaN) = %v, want NaN", got)
	}
}

func cloneTestSchema(schema Schema) Schema {
	copy := schema
	copy.Values = append([]ValueSpec(nil), schema.Values...)

	return copy
}
