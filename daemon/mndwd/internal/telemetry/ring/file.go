package ring

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
)

// ErrIO reports an operating-system or injected storage failure.
var ErrIO = errors.New("ring: i/o error")

// Ring owns a validated file and an in-memory view of its rows.
type Ring struct {
	file      File
	path      string
	schema    Schema
	readOnly  bool
	recreated bool
	closed    bool
	rows      [][]float32
	slots     []int64
	present   []bool
}

// Open opens a ring, creating or recreating it when create is true.
func Open(fsys FS, path string, schema Schema, create bool) (*Ring, error) {
	if fsys == nil {
		return nil, wrapIO("open", errors.New("nil filesystem"))
	}

	if err := validateSchema(schema); err != nil {
		return nil, err
	}

	file, err := fsys.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, wrapIO("open", err)
		}

		if !create {
			return nil, err
		}

		if err := fsys.MkdirAll(parentDir(path), 0o755); err != nil {
			return nil, wrapIO("mkdir", err)
		}

		file, err = fsys.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			file, err = fsys.OpenFile(path, os.O_RDWR, 0o600)
		}

		if err != nil {
			return nil, wrapIO("create", err)
		}

		if err := initializeFile(fsys, file, path, schema, false); err != nil {
			_ = file.Close()

			return nil, err
		}

		return newRing(file, path, schema, false, false), nil
	}

	contentErr, err := validateOpenHeader(file, schema)
	if err != nil {
		_ = file.Close()

		return nil, err
	}

	if contentErr != nil {
		if !create {
			_ = file.Close()

			return nil, fmt.Errorf("%w: %v", ErrInvalidHeader, contentErr)
		}

		if err := initializeFile(fsys, file, path, schema, true); err != nil {
			_ = file.Close()

			return nil, err
		}

		return newRing(file, path, schema, false, true), nil
	}

	stored := newRing(file, path, schema, false, false)

	if err := stored.loadRows(); err != nil {
		_ = file.Close()

		return nil, err
	}

	return stored, nil
}

// OpenReadOnly opens an existing ring without creating or modifying it.
func OpenReadOnly(fsys FS, path string, schema Schema) (*Ring, error) {
	empty := &Ring{path: path, schema: schema, readOnly: true}

	if fsys == nil {
		return empty, wrapIO("open", errors.New("nil filesystem"))
	}

	if err := validateSchema(schema); err != nil {
		return empty, err
	}

	empty = newRing(nil, path, schema, true, false)

	file, err := fsys.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return empty, nil
		}

		return empty, wrapIO("open", err)
	}

	contentErr, err := validateOpenHeader(file, schema)
	if err != nil {
		_ = file.Close()

		return empty, err
	}

	if contentErr != nil {
		_ = file.Close()

		return empty, nil
	}

	stored := newRing(file, path, schema, true, false)

	if err := stored.loadRows(); err != nil {
		_ = file.Close()

		return empty, err
	}

	_ = file.Close()
	stored.file = nil

	return stored, nil
}

// Recreated reports whether Open replaced a file with an invalid header or schema.
func (r *Ring) Recreated() bool {
	return r.recreated
}

// Write persists a row before publishing its values in memory.
func (r *Ring) Write(slot int64, values []float32) error {
	if r.readOnly {
		return errors.New("ring: read-only ring")
	}

	if r.closed || r.file == nil {
		return wrapIO("write", os.ErrClosed)
	}

	if slot < 0 || uint64(slot) >= math.MaxUint32 {
		return fmt.Errorf("ring: slot out of range: %d", slot)
	}

	row := EncodeRow(r.schema, slot, values)
	index := uint32(slot) % r.schema.Capacity
	offset := int64(HeaderSize) + int64(index)*int64(r.schema.RowSize())
	written, err := r.file.WriteAt(row, offset)
	if err != nil {
		return wrapIO("write row", err)
	}

	if written != len(row) {
		return wrapIO("write row", io.ErrShortWrite)
	}

	decoded, ok := DecodeRow(r.schema, row, slot)

	if !ok {
		return errors.New("ring: encoded row failed validation")
	}

	r.rows[index] = decoded
	r.slots[index] = slot
	r.present[index] = true

	return nil
}

// Values returns a copy of a row only when its slot key matches exactly.
func (r *Ring) Values(slot int64) ([]float32, bool) {
	if slot < 0 || uint64(slot) >= math.MaxUint32 || len(r.present) == 0 {
		return nil, false
	}

	index := uint32(slot) % r.schema.Capacity

	if !r.present[index] || r.slots[index] != slot {
		return nil, false
	}

	return append([]float32(nil), r.rows[index]...), true
}

// EachRow visits every present row in physical ring order.
func (r *Ring) EachRow(fn func(slot int64, values []float32)) {
	if fn == nil {
		return
	}

	for index, present := range r.present {
		if present {
			fn(r.slots[index], append([]float32(nil), r.rows[index]...))
		}
	}
}

// HasRows reports whether any valid row is present.
func (r *Ring) HasRows() bool {
	for _, present := range r.present {
		if present {
			return true
		}
	}

	return false
}

// Window returns a dense sequence, using NaN values for empty slots.
func (r *Ring) Window(startSlot int64, count int) [][]float32 {
	if count <= 0 {
		return [][]float32{}
	}

	window := make([][]float32, count)

	for index := range window {
		slot := startSlot + int64(index)

		if values, ok := r.Values(slot); ok {
			window[index] = values

			continue
		}

		window[index] = make([]float32, len(r.schema.Values))

		for valueIndex := range window[index] {
			window[index][valueIndex] = float32(math.NaN())
		}
	}

	return window
}

// Sync flushes pending row writes to storage.
func (r *Ring) Sync() error {
	if r.readOnly || r.file == nil {
		return nil
	}

	if r.closed {
		return wrapIO("sync", os.ErrClosed)
	}

	if err := r.file.Sync(); err != nil {
		return wrapIO("sync", err)
	}

	return nil
}

// Close closes the underlying file once.
func (r *Ring) Close() error {
	if r == nil || r.closed {
		return nil
	}

	r.closed = true

	if r.file == nil {
		return nil
	}

	if err := r.file.Close(); err != nil {
		return wrapIO("close", err)
	}

	return nil
}

func newRing(file File, path string, schema Schema, readOnly, recreated bool) *Ring {
	capacity := int(schema.Capacity)

	return &Ring{
		file:      file,
		path:      path,
		schema:    schema,
		readOnly:  readOnly,
		recreated: recreated,
		rows:      make([][]float32, capacity),
		slots:     make([]int64, capacity),
		present:   make([]bool, capacity),
	}
}

func initializeFile(fsys FS, file File, path string, schema Schema, recreate bool) error {
	if recreate {
		if err := file.Truncate(0); err != nil {
			return wrapIO("truncate", err)
		}
	}

	if err := file.Truncate(schema.FileSize()); err != nil {
		return wrapIO("truncate", err)
	}

	header, err := EncodeHeader(schema)
	if err != nil {
		return err
	}

	written, err := file.WriteAt(header, 0)
	if err != nil {
		return wrapIO("write header", err)
	}

	if written != len(header) {
		return wrapIO("write header", io.ErrShortWrite)
	}

	if err := file.Sync(); err != nil {
		return wrapIO("sync", err)
	}

	if err := fsys.SyncDir(parentDir(path)); err != nil {
		return wrapIO("sync directory", err)
	}

	return nil
}

func validateOpenHeader(file File, schema Schema) (error, error) {
	header := make([]byte, HeaderSize)
	n, err := file.ReadAt(header, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, wrapIO("read header", err)
	}

	if n != len(header) {
		return ErrInvalidHeader, nil
	}

	decoded, err := DecodeHeader(header)
	if err != nil {
		return err, nil
	}

	if !decoded.Equal(schema) {
		return fmt.Errorf("%w: schema mismatch", ErrInvalidHeader), nil
	}

	return nil, nil
}

func (r *Ring) loadRows() error {
	rowSize := r.schema.RowSize()

	for index := uint32(0); index < r.schema.Capacity; index++ {
		row := make([]byte, rowSize)
		offset := int64(HeaderSize) + int64(index)*int64(rowSize)
		n, err := r.file.ReadAt(row, offset)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return wrapIO("read row", err)
		}

		if n != len(row) {
			continue
		}

		key := uint64(binary.LittleEndian.Uint32(row[:4]))

		if key == 0 {
			continue
		}

		slot := int64(key - 1)

		if uint32(slot)%r.schema.Capacity != index {
			continue
		}

		values, ok := DecodeRow(r.schema, row, slot)

		if !ok {
			continue
		}

		r.rows[index] = values
		r.slots[index] = slot
		r.present[index] = true
	}

	return nil
}

func wrapIO(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrIO, operation, err)
}
