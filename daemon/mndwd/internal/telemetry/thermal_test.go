package telemetry

import (
	"context"
	"io/fs"
	"testing"
	"testing/fstest"
)

type mapThermalReader fstest.MapFS

func (f mapThermalReader) ReadDir(name string) ([]fs.DirEntry, error) {
	return fstest.MapFS(f).ReadDir(name)
}

func (f mapThermalReader) ReadFile(name string) ([]byte, error) {
	return fs.ReadFile(fstest.MapFS(f), name)
}

type thermalEntry struct {
	name string
	mode fs.FileMode
}

func (e thermalEntry) Name() string               { return e.name }
func (e thermalEntry) IsDir() bool                { return e.mode.IsDir() }
func (e thermalEntry) Type() fs.FileMode          { return e.mode }
func (e thermalEntry) Info() (fs.FileInfo, error) { return nil, nil }

type symlinkThermalReader struct {
	files map[string][]byte
}

func (r symlinkThermalReader) ReadDir(string) ([]fs.DirEntry, error) {
	return []fs.DirEntry{thermalEntry{
		name: "thermal_zone0",
		mode: fs.ModeSymlink,
	}}, nil
}

func (r symlinkThermalReader) ReadFile(name string) ([]byte, error) {
	data, ok := r.files[name]

	if !ok {
		return nil, fs.ErrNotExist
	}

	return data, nil
}

func TestThermalSamplerPrefersCPUZone(t *testing.T) {
	reader := mapThermalReader{
		"thermal_zone0/type": {Data: []byte("ambient\n")},
		"thermal_zone0/temp": {Data: []byte("30000\n")},
		"thermal_zone1/type": {Data: []byte("soc\n")},
		"thermal_zone1/temp": {Data: []byte("55000\n")},
	}
	value, err := NewThermalSampler(reader, ".").Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(value) != 1 || !value[0].Known || value[0].V != 55000 {
		t.Fatalf("value %#v", value)
	}
}

func TestThermalSamplerReadsSymlinkedZone(t *testing.T) {
	reader := symlinkThermalReader{files: map[string][]byte{
		"thermal_zone0/type": []byte("cpu-thermal\n"),
		"thermal_zone0/temp": []byte("62465\n"),
	}}
	value, err := NewThermalSampler(reader, ".").Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(value) != 1 || !value[0].Known || value[0].V != 62465 {
		t.Fatalf("value %#v", value)
	}
}
