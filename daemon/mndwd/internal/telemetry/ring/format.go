package ring

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"math"
	"strconv"
)

const (
	formatVersion = uint16(1)
	headerFields  = 21
	rowFixedSize  = 8
)

var (
	// ErrInvalidHeader reports a malformed or unsupported ring header.
	ErrInvalidHeader = errors.New("ring: invalid header")
	headerMagic      = []byte("MNDWRING")
)

// Kind identifies the slot key stored in a ring file.
type Kind uint8

const (
	// KindHistory stores UTC slot keys.
	KindHistory Kind = 1
	// KindPending stores boot-relative slot keys.
	KindPending Kind = 2
)

// HeaderSize is the fixed byte length of a ring file header.
const HeaderSize = 512

// ValueSpec names one float32 stored in each row.
type ValueSpec struct {
	Name string
	Unit string
}

// Schema describes a ring file's row layout and slot grid.
type Schema struct {
	Kind     Kind
	StepMs   uint32
	Capacity uint32
	Values   []ValueSpec
}

// SystemSchema returns the built-in three-minute system history or pending schema.
func SystemSchema(kind Kind) Schema {
	return Schema{
		Kind:     kind,
		StepMs:   180_000,
		Capacity: 14_400,
		Values: []ValueSpec{
			{Name: "cpu", Unit: "percent"},
			{Name: "ram", Unit: "percent"},
			{Name: "temp", Unit: "millicelsius"},
		},
	}
}

// RowSize returns the number of bytes in one row for the schema.
func (s Schema) RowSize() int {
	return rowFixedSize + 4*len(s.Values)
}

// FileSize returns the size of a dense ring file for the schema.
func (s Schema) FileSize() int64 {
	return int64(HeaderSize) + int64(s.Capacity)*int64(s.RowSize())
}

// Equal reports whether two schemas describe the same file layout.
func (s Schema) Equal(other Schema) bool {
	if s.Kind != other.Kind || s.StepMs != other.StepMs || s.Capacity != other.Capacity || len(s.Values) != len(other.Values) {
		return false
	}

	for index, value := range s.Values {
		if value != other.Values[index] {
			return false
		}
	}

	return true
}

// EncodeHeader encodes a schema into its fixed-size little-endian header.
func EncodeHeader(schema Schema) ([]byte, error) {
	if err := validateSchema(schema); err != nil {
		return nil, err
	}

	header := make([]byte, HeaderSize)

	copy(header[:len(headerMagic)], headerMagic)
	binary.LittleEndian.PutUint16(header[8:10], formatVersion)

	header[10] = byte(schema.Kind)
	header[11] = 0

	binary.LittleEndian.PutUint32(header[12:16], schema.StepMs)
	binary.LittleEndian.PutUint32(header[16:20], schema.Capacity)

	header[20] = byte(len(schema.Values))

	offset := headerFields

	for _, value := range schema.Values {
		if len(value.Name) > math.MaxUint8 || len(value.Unit) > math.MaxUint8 || offset+2+len(value.Name)+len(value.Unit)+4 > HeaderSize {
			return nil, fmt.Errorf("%w: value list exceeds header", ErrInvalidHeader)
		}

		header[offset] = byte(len(value.Name))
		offset++

		copy(header[offset:], value.Name)

		offset += len(value.Name)
		header[offset] = byte(len(value.Unit))
		offset++

		copy(header[offset:], value.Unit)

		offset += len(value.Unit)
	}

	binary.LittleEndian.PutUint32(header[offset:offset+4], crc32.ChecksumIEEE(header[:offset]))

	return header, nil
}

// DecodeHeader validates and decodes one complete fixed-size ring header.
func DecodeHeader(header []byte) (Schema, error) {
	invalid := func(reason string) (Schema, error) {
		return Schema{}, fmt.Errorf("%w: %s", ErrInvalidHeader, reason)
	}

	if len(header) != HeaderSize {
		return invalid("wrong length")
	}

	if !bytes.Equal(header[:len(headerMagic)], headerMagic) {
		return invalid("bad magic")
	}

	if binary.LittleEndian.Uint16(header[8:10]) != formatVersion {
		return invalid("unsupported version")
	}

	if header[11] != 0 {
		return invalid("reserved byte is not zero")
	}

	schema := Schema{
		Kind:     Kind(header[10]),
		StepMs:   binary.LittleEndian.Uint32(header[12:16]),
		Capacity: binary.LittleEndian.Uint32(header[16:20]),
	}
	count := int(header[20])

	if count == 0 {
		return invalid("empty value list")
	}

	offset := headerFields
	schema.Values = make([]ValueSpec, 0, count)

	for index := 0; index < count; index++ {
		if offset >= HeaderSize-4 {
			return invalid("value list overruns header")
		}

		nameLength := int(header[offset])
		offset++

		if offset+nameLength >= HeaderSize-4 {
			return invalid("name overruns header")
		}

		name := string(header[offset : offset+nameLength])
		offset += nameLength
		unitLength := int(header[offset])
		offset++

		if offset+unitLength > HeaderSize-4 {
			return invalid("unit overruns header")
		}

		unit := string(header[offset : offset+unitLength])
		offset += unitLength
		schema.Values = append(schema.Values, ValueSpec{Name: name, Unit: unit})
	}

	if err := validateSchema(schema); err != nil {
		return invalid("invalid schema")
	}

	if binary.LittleEndian.Uint32(header[offset:offset+4]) != crc32.ChecksumIEEE(header[:offset]) {
		return invalid("bad checksum")
	}

	if !allZero(header[offset+4:]) {
		return invalid("nonzero padding")
	}

	return schema, nil
}

// EncodeRow encodes one slot and its values with a little-endian CRC.
func EncodeRow(schema Schema, slot int64, values []float32) []byte {
	row := make([]byte, schema.RowSize())

	if slot >= 0 && slot < math.MaxUint32 {
		binary.LittleEndian.PutUint32(row[:4], uint32(slot+1))
	}

	for index := range schema.Values {
		value := float32(math.NaN())

		if index < len(values) {
			value = values[index]
		}

		binary.LittleEndian.PutUint32(row[4+index*4:8+index*4], math.Float32bits(value))
	}

	crcOffset := len(row) - 4

	binary.LittleEndian.PutUint32(row[crcOffset:], crc32.ChecksumIEEE(row[:crcOffset]))

	return row
}

// DecodeRow validates the exact slot key and row CRC before returning values.
func DecodeRow(schema Schema, row []byte, wantSlot int64) ([]float32, bool) {
	if len(row) != schema.RowSize() || wantSlot < 0 || wantSlot >= math.MaxUint32 {
		return nil, false
	}

	key := binary.LittleEndian.Uint32(row[:4])

	if key == 0 || uint64(key-1) != uint64(wantSlot) {
		return nil, false
	}

	crcOffset := len(row) - 4

	if binary.LittleEndian.Uint32(row[crcOffset:]) != crc32.ChecksumIEEE(row[:crcOffset]) {
		return nil, false
	}

	values := make([]float32, len(schema.Values))

	for index := range values {
		bits := binary.LittleEndian.Uint32(row[4+index*4 : 8+index*4])
		values[index] = math.Float32frombits(bits)
	}

	return values, true
}

// ToFloat64 converts a float32 to its shortest round-tripping decimal value.
func ToFloat64(value float32) float64 {
	if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
		return float64(value)
	}

	shortest := strconv.FormatFloat(float64(value), 'g', -1, 32)
	converted, err := strconv.ParseFloat(shortest, 64)
	if err != nil {
		return float64(value)
	}

	return converted
}

func validateSchema(schema Schema) error {
	if (schema.Kind != KindHistory && schema.Kind != KindPending) || schema.StepMs == 0 || schema.Capacity == 0 || len(schema.Values) == 0 || len(schema.Values) > math.MaxUint8 {
		return fmt.Errorf("%w: invalid schema fields", ErrInvalidHeader)
	}

	headerLength := headerFields + 4

	for _, value := range schema.Values {
		if value.Name == "" || value.Unit == "" || len(value.Name) > math.MaxUint8 || len(value.Unit) > math.MaxUint8 {
			return fmt.Errorf("%w: invalid value spec", ErrInvalidHeader)
		}

		headerLength += 2 + len(value.Name) + len(value.Unit)
	}

	if headerLength > HeaderSize {
		return fmt.Errorf("%w: value list exceeds header", ErrInvalidHeader)
	}

	return nil
}

func allZero(data []byte) bool {
	for _, value := range data {
		if value != 0 {
			return false
		}
	}

	return true
}
