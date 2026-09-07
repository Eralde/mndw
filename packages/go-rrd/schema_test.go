package rrd

import (
	"errors"
	"path/filepath"
	"context"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type recordingExecutor struct {
	results  []ExecResult
	commands [][]string
}

func (e *recordingExecutor) Run(_ context.Context, args ...string) (ExecResult, error) {
	e.commands = append(e.commands, append([]string(nil), args...))

	if len(e.results) == 0 {
		return ExecResult{}, nil
	}

	result := e.results[0]
	e.results = e.results[1:]

	return result, nil
}

func testSpec() CreateSpec {
	return CreateSpec{
		Step: 3 * time.Minute,
		DS: []DSSpec{
			{Name: "load", Type: "GAUGE", Heartbeat: 6 * time.Minute, Min: ptr(0), Max: ptr(100)},
			{Name: "memory", Type: "GAUGE", Heartbeat: 6 * time.Minute, Min: ptr(0), Max: ptr(100)},
		},
		RRA: []RRASpec{
			{CF: "AVERAGE", XFF: 0.5, Steps: 1, Rows: 480},
			{CF: "MIN", XFF: 0.5, Steps: 1, Rows: 480},
			{CF: "MAX", XFF: 0.5, Steps: 1, Rows: 480},
			{CF: "AVERAGE", XFF: 0.5, Steps: 20, Rows: 720},
			{CF: "MIN", XFF: 0.5, Steps: 20, Rows: 720},
			{CF: "MAX", XFF: 0.5, Steps: 20, Rows: 720},
		},
	}
}

func ptr(v float64) *float64 {
	return &v
}

func TestKnownRejectsNonFiniteValues(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("Known(%v) did not panic", value)
				}
			}()

			_ = Known(value)
		}()
	}
}

func TestEnsureValidatesExistingSchemaAndBuildsV1Create(t *testing.T) {
	info := `step = 180
rra[0].cf = AVERAGE
rra[0].xff = 0.5
rra[0].pdp_per_row = 1
rra[0].rows = 480
rra[1].cf = MIN
rra[1].xff = 0.5
rra[1].pdp_per_row = 1
rra[1].rows = 480
rra[2].cf = MAX
rra[2].xff = 0.5
rra[2].pdp_per_row = 1
rra[2].rows = 480
rra[3].cf = AVERAGE
rra[3].xff = 0.5
rra[3].pdp_per_row = 20
rra[3].rows = 720
rra[4].cf = MIN
rra[4].xff = 0.5
rra[4].pdp_per_row = 20
rra[4].rows = 720
rra[5].cf = MAX
rra[5].xff = 0.5
rra[5].pdp_per_row = 20
rra[5].rows = 720
ds[load].type = GAUGE
ds[load].minimal_heartbeat = 360
ds[load].min = 0
ds[load].max = 100
ds[memory].type = GAUGE
ds[memory].minimal_heartbeat = 360
ds[memory].min = 0
ds[memory].max = 100`
	path := t.TempDir() + "/telemetry.rrd"

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	executor := &recordingExecutor{results: []ExecResult{{Stdout: []byte(info)}}}
	file, err := NewFile(executor, path, testSpec())
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Ensure(context.Background(), time.Unix(1000, 0)); err != nil {
		t.Fatal(err)
	}

	if len(executor.commands) != 1 || executor.commands[0][0] != "info" {
		t.Fatalf("unexpected commands: %#v", executor.commands)
	}
}

func TestEnsureCreatesMissingFileAtomically(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/telemetry.rrd"
	executor := &recordingExecutor{results: []ExecResult{{}, {Stdout: []byte(infoOutputForTest())}}}
	file, err := NewFile(executor, path, testSpec())
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Ensure(context.Background(), time.Unix(1000, 0)); err != nil {
		t.Fatal(err)
	}

	if len(executor.commands) != 2 {
		t.Fatalf("got commands %#v", executor.commands)
	}

	if executor.commands[0][0] != "create" || executor.commands[1][0] != "info" {
		t.Fatalf("unexpected commands %#v", executor.commands)
	}

	if !strings.Contains(executor.commands[0][1], ".tmp-") {
		t.Fatalf("create did not target temp file: %#v", executor.commands)
	}

	if executor.commands[0][3] != "720" {
		t.Fatalf("create start was not aligned before enable time: %#v", executor.commands[0])
	}
}

func TestUpdateRejectsEmptyBatch(t *testing.T) {
	file, err := NewFile(&recordingExecutor{}, t.TempDir()+"/telemetry.rrd", testSpec())
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Update(context.Background(), nil); err == nil {
		t.Fatal("empty update batch accepted")
	}
}

func TestUnknownUpdateUsesUAndLastUpdateParsesTimestamp(t *testing.T) {
	path := t.TempDir() + "/telemetry.rrd"

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	executor := &recordingExecutor{results: []ExecResult{
		{Stdout: []byte("load memory\n\n1197: 1 2\n")},
		{},
		{Stdout: []byte("load memory\n\n1200: U 2\n")},
	}}
	file, err := NewFile(executor, path, testSpec())
	if err != nil {
		t.Fatal(err)
	}

	point := UpdatePoint{Timestamp: time.Unix(1200, 0), Values: []Value{Unknown, Known(2)}}

	if err := file.Update(context.Background(), []UpdatePoint{point}); err != nil {
		t.Fatal(err)
	}

	if got := executor.commands[1]; !reflect.DeepEqual(got, []string{"update", path, "1200:U:2"}) {
		t.Fatalf("unexpected update command: %#v", got)
	}

	last, err := file.LastUpdate(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if !last.Equal(time.Unix(1200, 0)) {
		t.Fatalf("last update %v", last)
	}
}

func TestParseLastUpdateAcceptsRRDtool12Output(t *testing.T) {
	last, err := parseLastUpdate([]byte(" value\n\n1788336000: 54000\n"))
	if err != nil {
		t.Fatal(err)
	}

	if !last.Equal(time.Unix(1788336000, 0)) {
		t.Fatalf("last update %v", last)
	}
}

func infoOutputForTest() string {
	return `step = 180
ds[0].name = load
ds[0].type = GAUGE
ds[0].minimal_heartbeat = 360
ds[0].min = 0
ds[0].max = 100
ds[1].name = memory
ds[1].type = GAUGE
ds[1].minimal_heartbeat = 360
ds[1].min = 0
ds[1].max = 100
rra[0].cf = AVERAGE
rra[0].xff = 0.5
rra[0].pdp_per_row = 1
rra[0].rows = 480
rra[1].cf = MIN
rra[1].xff = 0.5
rra[1].pdp_per_row = 1
rra[1].rows = 480
rra[2].cf = MAX
rra[2].xff = 0.5
rra[2].pdp_per_row = 1
rra[2].rows = 480
rra[3].cf = AVERAGE
rra[3].xff = 0.5
rra[3].pdp_per_row = 20
rra[3].rows = 720
rra[4].cf = MIN
rra[4].xff = 0.5
rra[4].pdp_per_row = 20
rra[4].rows = 720
rra[5].cf = MAX
rra[5].xff = 0.5
rra[5].pdp_per_row = 20
rra[5].rows = 720`
}

type recordingFileOps struct {
	calls   []string
	created []string
	linked  []string
	fail    string
}

func (o *recordingFileOps) record(name string) error {
	o.calls = append(o.calls, name)
	if o.fail == name {
		return errors.New("injected failure")
	}
	return nil
}

func (o *recordingFileOps) MkdirAll(string, os.FileMode) error { return o.record("mkdir") }

func (o *recordingFileOps) Stat(string) (os.FileInfo, error) {
	if err := o.record("stat"); err != nil {
		return nil, err
	}
	return nil, os.ErrNotExist
}

func (o *recordingFileOps) CreateTemp(dir, pattern string) (string, error) {
	if err := o.record("createTemp"); err != nil {
		return "", err
	}
	name := filepath.Join(dir, pattern+"1")
	o.created = append(o.created, name)
	return name, nil
}

func (o *recordingFileOps) Link(_, newPath string) error {
	if err := o.record("link"); err != nil {
		return err
	}
	o.linked = append(o.linked, newPath)
	return nil
}

func (o *recordingFileOps) Rename(_, _ string) error { return o.record("rename") }
func (o *recordingFileOps) Remove(_ string) error    { return o.record("remove") }

func TestEnsureUsesInjectedFileOps(t *testing.T) {
	ops := &recordingFileOps{}
	executor := &recordingExecutor{results: []ExecResult{{}, {Stdout: []byte(infoOutputForTest())}}}
	file, err := NewFile(executor, filepath.Join(t.TempDir(), "load.rrd"), testSpec(), WithFileOps(ops))
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Ensure(context.Background(), time.Unix(1800000180, 0).UTC()); err != nil {
		t.Fatal(err)
	}

	for _, expected := range []string{"stat", "mkdir", "createTemp", "link"} {
		found := false
		for _, call := range ops.calls {
			if call == expected {
				found = true
			}
		}
		if !found {
			t.Fatalf("Ensure did not use ops.%s: %v", expected, ops.calls)
		}
	}
	if len(executor.commands) < 2 || executor.commands[0][0] != "create" {
		t.Fatalf("commands=%v", executor.commands)
	}
	// Ensure aligns the requested time down to the preceding step.
	if got := executor.commands[0][3]; got != "1800000000" {
		t.Fatalf("create start=%q", got)
	}
}

func TestEnsureFailsWithoutTouchingFilesWhenOpsFail(t *testing.T) {
	ops := &recordingFileOps{fail: "createTemp"}
	file, err := NewFile(&recordingExecutor{}, filepath.Join(t.TempDir(), "load.rrd"), testSpec(), WithFileOps(ops))
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Ensure(context.Background(), time.Unix(1800000000, 0).UTC()); err == nil {
		t.Fatal("ops failure accepted")
	}
	for _, call := range ops.calls {
		if call == "link" {
			t.Fatal("installed a file after a scratch failure")
		}
	}
}

func TestDefaultFileOpsIsOSBacked(t *testing.T) {
	executor := &recordingExecutor{results: []ExecResult{{}, {Stdout: []byte(infoOutputForTest())}}}
	file, err := NewFile(executor, filepath.Join(t.TempDir(), "load.rrd"), testSpec())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := file.ops.(OSFileOps); !ok {
		t.Fatalf("default ops=%T", file.ops)
	}
	if err := file.Ensure(context.Background(), time.Unix(1800000180, 0).UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file.path); err != nil {
		t.Fatalf("default ops did not create the file: %v", err)
	}
}
