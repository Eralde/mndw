package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mndwd/internal/telemetry/journal"
)

func seedJournal(t *testing.T, rrdDir string) journal.StoragePaths {
	t.Helper()
	paths, err := journal.PathsFromRRDDir(rrdDir)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := journal.OpenStorage(context.Background(), paths, journal.OSFileSystem{}, journal.OSLocker{}, journal.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = opened.Writer.Close() }()

	boot := journal.BootID{1, 2, 3}
	start, err := journal.PrepareBootStart(journal.BootStart{Boot: boot, FirstAcquireElapsedMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	sample, err := journal.PrepareSample(journal.Sample{
		Boot:      boot,
		Series:    1,
		ElapsedMs: 180000,
		Values:    []journal.Value{{Known: true, V: 20}, {Known: false}},
	})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := journal.PrepareAnchor(journal.Anchor{
		Boot: boot, ElapsedMs: 180000, UTCMs: 1800000000000, UncertaintyMs: 7,
		EvidenceID: "ev-1", EvidenceSource: "fixture",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := opened.Writer.Append(context.Background(), []journal.Record{start, sample, anchor}); err != nil {
		t.Fatal(err)
	}
	if _, err := opened.Writer.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	return paths
}

func runDump(t *testing.T, args []string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(args, &out, Options{FileSystem: journal.OSFileSystem{}, Locker: journal.OSLocker{}})
	return out.String(), err
}

func TestDumpMissingDirectoryDoesNotCreateIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent")
	var out bytes.Buffer
	if err := run([]string{"--rrd-dir", path}, &out, Options{FileSystem: journal.OSFileSystem{}, Locker: journal.OSLocker{}}); err != nil {
		t.Fatalf("empty journal reported as failure: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("dump wrote storage")
	}
}

func TestDumpEmitsStatusBeforeRecords(t *testing.T) {
	paths := seedJournal(t, t.TempDir())
	output, err := runDump(t, []string{"--rrd-dir", paths.RRDDir})
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) < 2 {
		t.Fatalf("output=%q", output)
	}
	var status statusLine
	if err := json.Unmarshal([]byte(lines[0]), &status); err != nil {
		t.Fatal(err)
	}
	if status.Type != "status" || status.Mode != string(journal.StatusReady) {
		t.Fatalf("status=%+v", status)
	}
	var record recordLine
	if err := json.Unmarshal([]byte(lines[1]), &record); err != nil {
		t.Fatal(err)
	}
	if record.Type != "record" || record.Durability != "unproven" {
		t.Fatalf("record=%+v", record)
	}
	if record.Sequence != "1" || record.Kind != "boot-start" {
		t.Fatalf("record=%+v", record)
	}
}

func TestDumpMarksEveryOfflineRecordUnproven(t *testing.T) {
	paths := seedJournal(t, t.TempDir())
	output, err := runDump(t, []string{"--rrd-dir", paths.RRDDir})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var record recordLine
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type != "record" {
			continue
		}
		if record.Durability != "unproven" {
			t.Fatalf("offline dump claimed durability %q", record.Durability)
		}
	}
}

func TestDumpRendersNullableValuesAndUTC(t *testing.T) {
	paths := seedJournal(t, t.TempDir())
	output, err := runDump(t, []string{"--rrd-dir", paths.RRDDir})
	if err != nil {
		t.Fatal(err)
	}
	var sample, anchor recordLine
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var record recordLine
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record.Kind == "sample" {
			sample = record
		}
		if record.Kind == "anchor" {
			anchor = record
		}
	}
	if sample.Values == nil || len(sample.Values) != 2 {
		t.Fatalf("sample values=%v", sample.Values)
	}
	if sample.Values[0] == nil || *sample.Values[0] != 20 {
		t.Fatalf("known value=%v", sample.Values[0])
	}
	if sample.Values[1] != nil {
		t.Fatalf("unknown value rendered as %v", *sample.Values[1])
	}
	if sample.ElapsedMs == nil || *sample.ElapsedMs != 180000 {
		t.Fatalf("elapsed=%v", sample.ElapsedMs)
	}
	if anchor.UTCMs == nil || *anchor.UTCMs != 1800000000000 {
		t.Fatalf("utc=%v", anchor.UTCMs)
	}
}

func TestDumpSessionFilter(t *testing.T) {
	paths := seedJournal(t, t.TempDir())
	boot := journal.BootID{1, 2, 3}

	output, err := runDump(t, []string{"--rrd-dir", paths.RRDDir, "--session", "s1-" + boot.String()})
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var record recordLine
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "record" {
			count++
		}
	}
	if count != 3 {
		t.Fatalf("session filter returned %d records", count)
	}

	filtered, err := runDump(t, []string{"--rrd-dir", paths.RRDDir, "--session", "s1-ffffffffffffffffffffffffffffffff"})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(filtered), "\n") {
		var record recordLine
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "record" {
			t.Fatalf("filter leaked %+v", record)
		}
	}
}

func TestDumpRejectsUnknownArguments(t *testing.T) {
	if _, err := runDump(t, []string{"--rrd-dir", "/tmp", "extra"}); err == nil {
		t.Fatal("accepted an unexpected argument")
	}
	if _, err := runDump(t, []string{"--nope"}); err == nil {
		t.Fatal("accepted an unknown flag")
	}
}

func TestDumpDoesNotModifyStorage(t *testing.T) {
	paths := seedJournal(t, t.TempDir())
	before := dirListing(t, paths.JournalDir)
	if _, err := runDump(t, []string{"--rrd-dir", paths.RRDDir}); err != nil {
		t.Fatal(err)
	}
	after := dirListing(t, paths.JournalDir)
	if strings.Join(before, ",") != strings.Join(after, ",") {
		t.Fatalf("dump changed storage: %v then %v", before, after)
	}
}

func dirListing(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, entry.Name()+":"+itoa(info.Size()))
	}
	return names
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

var _ = io.Discard
