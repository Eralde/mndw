package ring_test

import (
	"errors"
	"io/fs"
	"math"
	"os"
	"syscall"
	"testing"

	"mndwd/internal/telemetry/ring"
	"mndwd/internal/telemetry/ring/ringtest"
)

func TestOpenCreatesSparseFileWithHeader(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := "rrd/ring/system.ring"
	schema := ring.SystemSchema(ring.KindHistory)
	var operations []string

	fsys.OnOp(func(op, name string) {
		operations = append(operations, op+":"+name)
	})

	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	defer func() { _ = stored.Close() }()

	if got, want := len(fsys.Bytes(path)), int(schema.FileSize()); got != want {
		t.Fatalf("file size = %d, want %d", got, want)
	}

	decoded, err := ring.DecodeHeader(fsys.Bytes(path)[:ring.HeaderSize])
	if err != nil {
		t.Fatalf("DecodeHeader: %v", err)
	}

	if !decoded.Equal(schema) {
		t.Fatalf("header schema = %#v, want %#v", decoded, schema)
	}

	if stored.HasRows() {
		t.Fatal("new ring unexpectedly has rows")
	}

	syncIndex := operationIndex(operations, "sync:"+path)
	dirSyncIndex := operationIndex(operations, "syncdir:rrd/ring")

	if syncIndex < 0 || dirSyncIndex < 0 || syncIndex >= dirSyncIndex {
		t.Fatalf("file Sync must precede parent SyncDir; operations = %v", operations)
	}
}

func TestOpenLoadsValidRows(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := "rrd/ring/system.ring"
	schema := ring.SystemSchema(ring.KindHistory)
	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	want := map[int64][]float32{
		3: {1, 2, 3},
		5: {4, 5, 6},
		7: {7, 8, 9},
	}

	for slot, values := range want {
		if err := stored.Write(slot, values); err != nil {
			t.Fatalf("Write(%d): %v", slot, err)
		}
	}

	if err := stored.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := ring.Open(fsys, path, schema, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}

	defer func() { _ = reopened.Close() }()

	for slot, values := range want {
		got, ok := reopened.Values(slot)

		if !ok || !equalFloats(got, values) {
			t.Errorf("Values(%d) = %v, %v; want %v, true", slot, got, ok, values)
		}
	}

	if _, ok := reopened.Values(4); ok {
		t.Fatal("unwritten slot 4 is present")
	}
}

func TestOpenRecreatesOnInvalidHeader(t *testing.T) {
	schema := ring.SystemSchema(ring.KindHistory)
	tests := []struct {
		name   string
		create func(*testing.T, *ringtest.MemFS, string)
	}{
		{name: "bad magic", create: func(t *testing.T, fsys *ringtest.MemFS, path string) {
			createRingForTest(t, fsys, path, schema)
			corruptFileForTest(t, fsys, path, 0, 0xff)
		}},
		{name: "bad crc", create: func(t *testing.T, fsys *ringtest.MemFS, path string) {
			createRingForTest(t, fsys, path, schema)
			corruptFileForTest(t, fsys, path, 62, 0xff)
		}},
		{name: "schema mismatch", create: func(t *testing.T, fsys *ringtest.MemFS, path string) {
			other := schema
			other.Capacity++

			createRingForTest(t, fsys, path, other)
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fsys := ringtest.NewMemFS()
			path := "rrd/ring/system.ring"

			test.create(t, fsys, path)

			stored, err := ring.Open(fsys, path, schema, true)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}

			defer func() { _ = stored.Close() }()

			if !stored.Recreated() {
				t.Fatal("Recreated() = false, want true")
			}

			if stored.HasRows() {
				t.Fatal("recreated ring unexpectedly has rows")
			}

			got, err := ring.DecodeHeader(fsys.Bytes(path)[:ring.HeaderSize])
			if err != nil || !got.Equal(schema) {
				t.Fatalf("recreated header = %#v, %v; want %#v", got, err, schema)
			}
		})
	}
}

func TestOpenReadErrorLeavesFileUntouched(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := "rrd/ring/system.ring"
	schema := ring.SystemSchema(ring.KindHistory)

	createRingForTest(t, fsys, path, schema)

	before := fsys.Bytes(path)

	fsys.FailNext("readat", path, syscall.EIO)

	stored, err := ring.Open(fsys, path, schema, true)

	if stored != nil {
		_ = stored.Close()
	}

	if !errors.Is(err, ring.ErrIO) {
		t.Fatalf("Open error = %v, want ErrIO", err)
	}

	if got := fsys.Bytes(path); string(got) != string(before) {
		t.Fatal("file changed after read error")
	}
}

func TestOpenNoCreateNeverRecreates(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := "rrd/ring/system.ring"
	schema := ring.SystemSchema(ring.KindHistory)

	createRingForTest(t, fsys, path, schema)
	corruptFileForTest(t, fsys, path, 0, 0xff)

	before := fsys.Bytes(path)
	var operations []string

	fsys.OnOp(func(op, name string) { operations = append(operations, op+":"+name) })

	stored, err := ring.Open(fsys, path, schema, false)

	if stored != nil {
		_ = stored.Close()
	}

	if !errors.Is(err, ring.ErrInvalidHeader) {
		t.Fatalf("Open error = %v, want ErrInvalidHeader", err)
	}

	if operationIndex(operations, "writeat:"+path) >= 0 || operationIndex(operations, "truncate:"+path) >= 0 {
		t.Fatalf("non-creating open modified file: %v", operations)
	}

	if got := fsys.Bytes(path); string(got) != string(before) {
		t.Fatal("file changed after non-creating open")
	}
}

func TestOpenErrorClasses(t *testing.T) {
	schema := ring.SystemSchema(ring.KindHistory)

	t.Run("missing", func(t *testing.T) {
		_, err := ring.Open(ringtest.NewMemFS(), "missing.ring", schema, false)
		if !errors.Is(err, fs.ErrNotExist) || errors.Is(err, ring.ErrIO) {
			t.Fatalf("Open error = %v, want fs.ErrNotExist without ErrIO", err)
		}
	})

	for _, cause := range []error{syscall.EIO, syscall.EROFS} {
		t.Run(cause.Error(), func(t *testing.T) {
			fsys := ringtest.NewMemFS()
			path := "rrd/ring/system.ring"

			createRingForTest(t, fsys, path, schema)
			fsys.FailNext("open", path, cause)

			_, err := ring.Open(fsys, path, schema, false)
			if !errors.Is(err, ring.ErrIO) {
				t.Fatalf("Open error = %v, want ErrIO", err)
			}
		})
	}
}

func TestWriteFailureKeepsMemoryUnchanged(t *testing.T) {
	fsys := ringtest.NewMemFS()
	path := "rrd/ring/system.ring"
	schema := ring.SystemSchema(ring.KindHistory)
	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	defer func() { _ = stored.Close() }()

	want := []float32{1, 2, 3}

	if err := stored.Write(8, want); err != nil {
		t.Fatalf("initial Write: %v", err)
	}

	fsys.FailNext("writeat", path, syscall.EIO)

	if err := stored.Write(8, []float32{4, 5, 6}); !errors.Is(err, ring.ErrIO) {
		t.Fatalf("failed Write error = %v, want ErrIO", err)
	}

	got, ok := stored.Values(8)

	if !ok || !equalFloats(got, want) {
		t.Fatalf("Values(8) = %v, %v; want %v, true", got, ok, want)
	}
}

func TestWindowDenseWithNaN(t *testing.T) {
	fsys := ringtest.NewMemFS()
	stored, err := ring.Open(fsys, "rrd/ring/system.ring", ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	defer func() { _ = stored.Close() }()

	if err := stored.Write(20, []float32{1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	if err := stored.Write(22, []float32{4, 5, 6}); err != nil {
		t.Fatal(err)
	}

	window := stored.Window(20, 4)

	if len(window) != 4 {
		t.Fatalf("Window length = %d, want 4", len(window))
	}

	if !equalFloats(window[0], []float32{1, 2, 3}) || !equalFloats(window[2], []float32{4, 5, 6}) {
		t.Fatalf("populated rows = %v and %v", window[0], window[2])
	}

	for _, index := range []int{1, 3} {
		if len(window[index]) != 3 {
			t.Fatalf("Window[%d] length = %d, want 3", index, len(window[index]))
		}

		for _, value := range window[index] {
			if !math.IsNaN(float64(value)) {
				t.Errorf("Window[%d] = %v, want all NaN", index, window[index])

				break
			}
		}
	}
}

func TestStaleRowAtSamePositionIsEmpty(t *testing.T) {
	fsys := ringtest.NewMemFS()
	stored, err := ring.Open(fsys, "rrd/ring/system.ring", ring.SystemSchema(ring.KindHistory), true)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	defer func() { _ = stored.Close() }()

	const slot int64 = 20

	if err := stored.Write(slot, []float32{1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	if _, ok := stored.Values(slot + 14400); ok {
		t.Fatal("same-position stale row matched a later slot")
	}

	window := stored.Window(slot+14400, 1)

	for _, value := range window[0] {
		if !math.IsNaN(float64(value)) {
			t.Fatalf("Window stale row = %v, want all NaN", window[0])
		}
	}
}

func TestOpenReadOnlyNeverWrites(t *testing.T) {
	schema := ring.SystemSchema(ring.KindHistory)

	for _, test := range []struct {
		name  string
		setup func(*testing.T, *ringtest.MemFS, string)
	}{
		{name: "missing"},
		{name: "bad header", setup: func(t *testing.T, fsys *ringtest.MemFS, path string) {
			createRingForTest(t, fsys, path, schema)
			corruptFileForTest(t, fsys, path, 0, 0xff)
		}},
		{name: "schema mismatch", setup: func(t *testing.T, fsys *ringtest.MemFS, path string) {
			other := schema
			other.Capacity++

			createRingForTest(t, fsys, path, other)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fsys := ringtest.NewMemFS()
			path := "rrd/ring/system.ring"

			if test.setup != nil {
				test.setup(t, fsys, path)
			}

			before := fsys.Bytes(path)
			var operations []string

			fsys.OnOp(func(op, name string) { operations = append(operations, op+":"+name) })

			stored, err := ring.OpenReadOnly(fsys, path, schema)
			if err != nil {
				t.Fatalf("OpenReadOnly: %v", err)
			}

			defer func() { _ = stored.Close() }()

			if stored.HasRows() {
				t.Fatal("read-only empty ring unexpectedly has rows")
			}

			for _, operation := range operations {
				if operation != "open:"+path && operation != "readat:"+path && operation != "close:"+path {
					t.Fatalf("read-only open performed %q", operation)
				}
			}

			if test.name == "missing" && len(operations) != 1 {
				t.Fatalf("missing read-only open operations = %v, want only open", operations)
			}

			if test.name != "missing" && len(operations) == 0 {
				t.Fatal("existing file was not read")
			}

			if got := fsys.Bytes(path); string(got) != string(before) {
				t.Fatal("read-only open changed file")
			}

			if err := stored.Write(1, []float32{1, 2, 3}); err == nil {
				t.Fatal("Write on read-only ring succeeded")
			}
		})
	}
}

func createRingForTest(t *testing.T, fsys *ringtest.MemFS, path string, schema ring.Schema) {
	t.Helper()

	stored, err := ring.Open(fsys, path, schema, true)
	if err != nil {
		t.Fatalf("create ring: %v", err)
	}

	if err := stored.Close(); err != nil {
		t.Fatalf("close created ring: %v", err)
	}
}

func corruptFileForTest(t *testing.T, fsys *ringtest.MemFS, path string, offset int64, value byte) {
	t.Helper()

	file, err := fsys.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("open file to corrupt: %v", err)
	}

	if _, err := file.WriteAt([]byte{value}, offset); err != nil {
		t.Fatalf("corrupt file: %v", err)
	}

	if err := file.Close(); err != nil {
		t.Fatalf("close corrupted file: %v", err)
	}
}

func operationIndex(operations []string, want string) int {
	for index, operation := range operations {
		if operation == want {
			return index
		}
	}

	return -1
}

func equalFloats(left, right []float32) bool {
	if len(left) != len(right) {
		return false
	}

	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}

	return true
}
