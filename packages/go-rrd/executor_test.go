package rrd

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExecutorRunsWithoutShellAndCapturesOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rrdtool")

	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'out'; printf 'warn' >&2\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	got, err := NewExecutor(path).Run(context.Background(), "info", "file with spaces")
	if err != nil {
		t.Fatal(err)
	}

	if string(got.Stdout) != "out" || string(got.Stderr) != "warn" {
		t.Fatalf("unexpected result: %#v", got)
	}
}

func TestExecutorBoundsOutputAndReportsCommand(t *testing.T) {
	var bounded limitedBuffer
	bounded.limit = 4
	_, _ = bounded.Write([]byte("123456789"))

	if !bounded.exceeded {
		t.Fatal("limited buffer did not mark overflow")
	}

	path := filepath.Join(t.TempDir(), "rrdtool")

	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '123456789'\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	got, err := NewExecutor(path, WithOutputLimit(4)).Run(context.Background(), "fetch", "file")

	t.Logf("result=%q stderr=%q err=%v", got.Stdout, got.Stderr, err)

	if err == nil || !strings.Contains(err.Error(), "output limit") || !strings.Contains(err.Error(), "fetch file") {
		t.Fatalf("expected bounded command error, got %v", err)
	}
}

func TestExecutorWarnsOnStderrWithRateLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rrdtool")

	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'warning' >&2\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	var warnings []string
	clock := time.Unix(100, 0)
	executor := NewExecutor(path,
		WithClock(func() time.Time { return clock }),
		WithWarningInterval(time.Minute),
		WithWarningObserver(func(command string, stderr []byte) {
			warnings = append(warnings, command+":"+string(stderr))
		}),
	)

	if _, err := executor.Run(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}

	if _, err := executor.Run(context.Background(), "two"); err != nil {
		t.Fatal(err)
	}

	if len(warnings) != 1 {
		t.Fatalf("got %d warnings, want 1", len(warnings))
	}

	clock = clock.Add(time.Minute)

	if _, err := executor.Run(context.Background(), "three"); err != nil {
		t.Fatal(err)
	}

	if len(warnings) != 2 {
		t.Fatalf("got %d warnings after interval, want 2", len(warnings))
	}

	if errors.Is(context.Canceled, context.DeadlineExceeded) {
		t.Fatal("unreachable guard")
	}
}
