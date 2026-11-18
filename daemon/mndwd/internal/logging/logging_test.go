package logging

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRotatingFileReplacesBackupAndAcceptsWritesAfterRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mndwd.log")
	file, err := OpenRotatingFile(path, 5)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = file.Close() })

	if _, err := file.Write([]byte("abcde")); err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path+".1", []byte("stale backup"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write([]byte("1234")); err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write([]byte("z")); err != nil {
		t.Fatal(err)
	}

	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	backup, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}

	if string(current) != "z" || string(backup) != "x1234" {
		t.Fatalf("current=%q backup=%q, want current %q and latest backup %q", current, backup, "z", "x1234")
	}
}

func TestOpenRotatingFileRetriesAfterInitialFailure(t *testing.T) {
	root := t.TempDir()
	blockedDirectory := filepath.Join(root, "blocked")

	if err := os.WriteFile(blockedDirectory, []byte("file blocks directory creation"), 0o600); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(blockedDirectory, "mndwd.log")
	file, err := OpenRotatingFile(path, 64)

	if file == nil {
		t.Fatal("OpenRotatingFile returned nil writer after initial open failure")
	}

	defer func() { _ = file.Close() }()

	if err == nil {
		t.Fatal("OpenRotatingFile succeeded while parent path was a file")
	}

	if n, err := file.Write([]byte("dropped\n")); err == nil || n != 0 {
		t.Fatalf("write while path was blocked = %d, %v; want dropped write with error", n, err)
	}

	if err := os.Remove(blockedDirectory); err != nil {
		t.Fatal(err)
	}

	if err := os.Mkdir(blockedDirectory, 0o700); err != nil {
		t.Fatal(err)
	}

	if n, err := file.Write([]byte("resumed\n")); err != nil || n != len("resumed\n") {
		t.Fatalf("write after log path recovery = %d, %v", n, err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if string(got) != "resumed\n" {
		t.Fatalf("recovered log = %q, want resumed record only", got)
	}
}

func TestRotatingFileConcurrentWritersStayWithinTwoFileLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mndwd.log")
	file, err := OpenRotatingFile(path, 32)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = file.Close() })

	var writers sync.WaitGroup

	for worker := range 8 {
		writers.Add(1)

		go func() {
			defer writers.Done()

			for row := range 100 {
				if _, err := file.Write([]byte(fmt.Sprintf("%03d\n", row))); err != nil {
					t.Errorf("concurrent write: %v", err)

					return
				}
			}
		}()

		_ = worker
	}

	writers.Wait()

	for _, name := range []string{path, path + ".1"} {
		info, err := os.Stat(name)
		if err == nil && info.Size() > 32 {
			t.Errorf("%s size = %d, want at most 32", name, info.Size())
		} else if err != nil && !os.IsNotExist(err) {
			t.Errorf("stat %s: %v", name, err)
		}
	}
}

func TestOpenRotatingFileBoundsExistingLog(t *testing.T) {
	const limit = 20

	tests := []struct {
		name    string
		content string
		want    string
	}{
		{name: "below limit", content: "one\ntwo\n", want: "one\ntwo\n"},
		{name: "at limit", content: strings.Repeat("x", limit), want: strings.Repeat("x", limit)},
		{name: "above limit keeps complete tail lines", content: strings.Repeat("old\n", 8) + "partial-line-that-is-too-long\nlast-one\nlast-two\n", want: "last-one\nlast-two\n"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "mndwd.log")

			if err := os.WriteFile(path, []byte(test.content), 0o600); err != nil {
				t.Fatal(err)
			}

			file, err := OpenRotatingFile(path, limit)
			if err != nil {
				t.Fatal(err)
			}

			defer func() { _ = file.Close() }()

			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			if string(got) != test.want {
				t.Fatalf("active log = %q, want %q", got, test.want)
			}

			if info, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
				t.Fatalf("unexpected startup backup stat=%v info=%v", err, info)
			}
		})
	}
}

func TestRotatingFileRecoversAfterRotationError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mndwd.log")
	file, err := OpenRotatingFile(path, 8)
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = file.Close() }()

	if _, err := file.Write([]byte("12345678")); err != nil {
		t.Fatal(err)
	}

	backupPath := path + ".1"

	if err := os.Mkdir(backupPath, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(backupPath, "keep"), []byte("blocks removal"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write([]byte("dropped")); err == nil {
		t.Fatal("write succeeded while rotation was blocked")
	}

	if err := os.RemoveAll(backupPath); err != nil {
		t.Fatal(err)
	}

	if _, err := file.Write([]byte("b")); err != nil {
		t.Fatalf("write did not recover after rotation error cleared: %v", err)
	}

	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	backup, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(current) != "b" || string(backup) != "12345678" {
		t.Fatalf("current=%q backup=%q, want current %q and backup %q", current, backup, "b", "12345678")
	}
}

func TestRepeatHandlerCollapsesEqualRecordsAndSeparatesAttributes(t *testing.T) {
	var output bytes.Buffer
	base := slog.NewTextHandler(&output, nil)
	handler := NewRepeatHandler(base, RepeatHandlerConfig{DisableTicker: true})
	logger := slog.New(handler)

	logger.Warn("router unavailable", "target", "controller")
	logger.Warn("router unavailable", "target", "controller")
	logger.Warn("router unavailable", "target", "extender")

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}

	text := output.String()

	if got := strings.Count(text, "msg=\"router unavailable\""); got != 2 {
		t.Fatalf("original message count = %d, want 2; output:\n%s", got, text)
	}

	if !strings.Contains(text, "level=WARN msg=\"last message repeated 1 times\"") {
		t.Fatalf("missing warning repeat summary: %s", text)
	}

	if strings.Index(text, "last message repeated 1 times") > strings.LastIndex(text, "target=extender") {
		t.Fatalf("repeat summary must precede the different record: %s", text)
	}
}

func TestRepeatHandlerFlushesExpiredCountAndRetainsLevel(t *testing.T) {
	var output bytes.Buffer
	base := slog.NewTextHandler(&output, nil)
	current := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	handler := NewRepeatHandler(base, RepeatHandlerConfig{
		Now:           func() time.Time { return current },
		FlushInterval: time.Hour,
		DisableTicker: true,
	})
	logger := slog.New(handler)

	logger.Error("poll failed", "target", "controller")
	logger.Error("poll failed", "target", "controller")

	current = current.Add(time.Hour)

	if err := handler.flushExpired(); err != nil {
		t.Fatal(err)
	}

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}

	text := output.String()

	if !strings.Contains(text, "level=ERROR msg=\"last message repeated 1 times\"") {
		t.Fatalf("missing hourly error summary: %s", text)
	}

	if got := strings.Count(text, "last message repeated"); got != 1 {
		t.Fatalf("summary count = %d, want 1: %s", got, text)
	}
}

func TestRepeatSummaryUsesCappedWriterBeforeNextRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mndwd.log")
	file, err := OpenRotatingFile(path, 300)
	if err != nil {
		t.Fatal(err)
	}

	base := slog.NewTextHandler(file, nil)
	handler := NewRepeatHandler(base, RepeatHandlerConfig{DisableTicker: true})

	logger := slog.New(handler)

	logger.Warn("repeated message", "target", "controller")
	logger.Warn("repeated message", "target", "controller")
	logger.Info(strings.Repeat("next", 50))

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	backup, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(backup), "last message repeated 1 times") {
		t.Fatalf("rotation backup omitted pending repeat summary: %s", backup)
	}
}

func TestRepeatHandlerHourlySummariesStayWithinFileLimit(t *testing.T) {
	const limit = 200
	path := filepath.Join(t.TempDir(), "mndwd.log")
	file, err := OpenRotatingFile(path, limit)
	if err != nil {
		t.Fatal(err)
	}

	base := slog.NewTextHandler(file, nil)
	current := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	handler := NewRepeatHandler(base, RepeatHandlerConfig{
		Now:           func() time.Time { return current },
		FlushInterval: time.Hour,
		DisableTicker: true,
	})
	logger := slog.New(handler).With("padding", strings.Repeat("x", 80))

	logger.Warn("repeat")

	for range 50 {
		logger.Warn("repeat")

		current = current.Add(time.Hour)

		if err := handler.flushExpired(); err != nil {
			t.Fatal(err)
		}
	}

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{path, path + ".1"} {
		info, err := os.Stat(name)
		if err == nil && info.Size() > limit {
			t.Errorf("%s size = %d, want at most %d", name, info.Size(), limit)
		} else if err != nil && !os.IsNotExist(err) {
			t.Errorf("stat %s: %v", name, err)
		}
	}
}

func TestRepeatHandlerWithAttrsAndGroupsIncludeEffectiveAttributes(t *testing.T) {
	var output bytes.Buffer
	base := slog.NewTextHandler(&output, nil)
	handler := NewRepeatHandler(base, RepeatHandlerConfig{DisableTicker: true})
	logger := slog.New(handler).With("service", "events").WithGroup("rci")

	logger.Info("poll", "target", "controller")
	logger.Info("poll", "target", "controller")
	logger.Info("poll", "target", "extender")

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}

	text := output.String()

	if !strings.Contains(text, "service=events") || !strings.Contains(text, "rci.target=controller") {
		t.Fatalf("effective attributes missing from output: %s", text)
	}

	if !strings.Contains(text, "last message repeated 1 times") {
		t.Fatalf("grouped repeated records were not collapsed: %s", text)
	}
}

func TestRepeatHandlerCanWriteToDiscardingBase(t *testing.T) {
	handler := NewRepeatHandler(slog.DiscardHandler, RepeatHandlerConfig{DisableTicker: true})

	if err := handler.Handle(context.Background(), slog.NewRecord(time.Now(), slog.LevelInfo, "quiet", 0)); err != nil && err != io.EOF {
		t.Fatal(err)
	}

	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}
}
