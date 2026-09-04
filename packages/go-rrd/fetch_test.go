package rrd

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestFetchGroupParsesTargetShapedOutputAndUnknowns(t *testing.T) {
	path := t.TempDir() + "/telemetry.rrd"

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	executor := &recordingExecutor{results: []ExecResult{
		{Stdout: []byte("             load memory\n1700: 1.0 2.0\n1880: nan 3.0\n2060: 4.0 -nan\n")},
	}}
	file, err := NewFile(executor, path, testSpec())
	if err != nil {
		t.Fatal(err)
	}

	result, err := file.FetchGroup(context.Background(), []FetchRequest{{
		CF:         "AVERAGE",
		Resolution: 3 * time.Minute,
		Start:      time.Unix(1700, 0),
		End:        time.Unix(2060, 0),
	}})
	if err != nil {
		t.Fatal(err)
	}

	if len(result) != 1 || len(result[0].Rows) != 3 {
		t.Fatalf("unexpected fetch result %#v", result)
	}

	if result[0].Rows[1].Values[0].Known || !result[0].Rows[1].Values[1].Known {
		t.Fatalf("unexpected unknown decoding %#v", result[0].Rows[1])
	}

	if result[0].Step != 3*time.Minute {
		t.Fatalf("step %v", result[0].Step)
	}
}

func TestFetchGroupReturnsMissingWithoutRunningRRDTool(t *testing.T) {
	executor := &recordingExecutor{}
	file, err := NewFile(executor, "/definitely/missing/telemetry.rrd", testSpec())
	if err != nil {
		t.Fatal(err)
	}

	_, err = file.FetchGroup(context.Background(), []FetchRequest{{CF: "AVERAGE", Resolution: time.Minute}})
	if !errors.Is(err, ErrFileMissing) {
		t.Fatalf("error %v", err)
	}

	if len(executor.commands) != 0 {
		t.Fatalf("missing fetch invoked executor: %#v", executor.commands)
	}
}
