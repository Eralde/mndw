package ttyd

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProcessStartReportsMissingBinaryFromEnvironment(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-ttyd")
	process := New(func(name string) string {
		if name == "MNDW_TTYD_BIN" {
			return missing
		}

		return ""
	}, ConsoleNDMC)

	err := process.Start(context.Background())
	if err == nil {
		t.Fatal("Start() error = nil, want missing ttyd error")
	}

	if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("Start() error = %v, want fs.ErrNotExist or exec.ErrNotFound", err)
	}
}

func TestProcessUsesPrivateLoopbackAndStopsOwnedGroup(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	bin := filepath.Join(dir, "ttyd")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + argsPath + "\"\nsleep 30\n"

	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	process := New(func(name string) string {
		if name == "MNDW_TTYD_BIN" {
			return bin
		}

		return ""
	}, ConsoleNDMC)

	if err := process.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	var args []byte
	var err error

	for attempt := 0; attempt < 100; attempt++ {
		args, err = os.ReadFile(argsPath)
		if err == nil {
			break
		}

		time.Sleep(5 * time.Millisecond)
	}

	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(args), "-i\n127.0.0.1\n-p\n7681") {
		t.Fatalf("ttyd args = %q", args)
	}

	if !strings.Contains(string(args), "-W\nndmc") {
		t.Fatalf("ttyd args = %q, want -W ndmc", args)
	}

	if err := process.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	if process.Running() {
		t.Fatal("owned ttyd command still running after stop")
	}
}

func TestProcessEntwareUsesItsOwnPortAndShell(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	bin := filepath.Join(dir, "ttyd")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + argsPath + "\"\nsleep 30\n"

	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	process := New(func(name string) string {
		if name == "MNDW_TTYD_BIN" {
			return bin
		}

		return ""
	}, ConsoleEntware)

	if err := process.Start(context.Background()); err != nil {
		t.Fatal(err)
	}

	defer func() { _ = process.Stop(context.Background()) }()

	var args []byte
	var err error

	for attempt := 0; attempt < 100; attempt++ {
		args, err = os.ReadFile(argsPath)
		if err == nil {
			break
		}

		time.Sleep(5 * time.Millisecond)
	}

	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(args), "-i\n127.0.0.1\n-p\n7682") {
		t.Fatalf("ttyd args = %q", args)
	}

	if !strings.Contains(string(args), "-W\n/opt/bin/sh") {
		t.Fatalf("ttyd args = %q, want -W /opt/bin/sh", args)
	}
}
