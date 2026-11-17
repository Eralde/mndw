package opkg

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMetadataUpdatedAtUsesNewestEntryMtime(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "old")
	newPath := filepath.Join(dir, "new")

	if err := os.WriteFile(oldPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(newPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	old := time.Unix(100, 0)
	newer := time.Unix(200, 0)

	if err := os.Chtimes(oldPath, old, old); err != nil {
		t.Fatal(err)
	}

	if err := os.Chtimes(newPath, newer, newer); err != nil {
		t.Fatal(err)
	}

	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed", "opkg list":
			return "", 0, nil
		default:
			return "", 0, errors.New("unexpected command")
		}
	}
	m := newExecManagerWithRunner(t, runner)
	m.listsDir = dir
	result, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if result.MetadataUpdatedAt == nil || !result.MetadataUpdatedAt.Equal(newer.UTC()) {
		t.Fatalf("metadataUpdatedAt = %v, want %v", result.MetadataUpdatedAt, newer.UTC())
	}
}

func TestExecListMergeAndOrphan(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed":
			return "curl - 7.55.1-1 - Installed desc\norphan - 2.1.0-1 - Custom tool\n", 0, nil
		case "opkg list":
			return "curl - 8.0.1-1 - Feed desc\nsocat - 1.7.4.4-1 - Relay\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if len(entries) != 3 {
		t.Fatalf("len(entries) = %d, want 3", len(entries))
	}

	if entries[0].Name != "curl" || entries[0].Version != "7.55.1-1" || entries[0].Description != "Feed desc" || entries[0].Status != "update_available" || entries[0].NewVersion != "8.0.1-1" {
		t.Errorf("curl entry = %+v", entries[0])
	}

	if entries[1].Name != "orphan" || entries[1].Version != "2.1.0-1" || entries[1].Description != "Custom tool" || entries[1].Status != "installed" || entries[1].NewVersion != "" {
		t.Errorf("orphan entry = %+v", entries[1])
	}

	if entries[2].Name != "socat" || entries[2].Status != "available" {
		t.Errorf("socat entry = %+v", entries[2])
	}
}

func TestExecListIgnoresArchitectureWarnings(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		switch strings.Join(args, " ") {
		case "opkg list-installed":
			return "curl - 7.55.1-1 - Installed desc\n", 0, nil
		case "opkg list":
			return "Package mndw version 0.0.1 has no valid architecture, ignoring.\n" +
				"curl - 8.0.1-1 - Feed desc\n" +
				"socat - 1.7.4.4-1 - Relay\n", 0, nil
		default:
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}

	if entries[0].Name != "curl" || entries[0].Status != "update_available" {
		t.Errorf("curl entry = %+v", entries[0])
	}

	if entries[1].Name != "socat" || entries[1].Status != "available" {
		t.Errorf("socat entry = %+v", entries[1])
	}
}

func TestExecListEmptyOutput(t *testing.T) {
	runner := func(_ context.Context, _ ...string) (string, int, error) {
		return "", 0, nil
	}

	result, err := newExecManagerWithRunner(t, runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages

	if entries == nil || len(entries) != 0 {
		t.Errorf("entries = %#v, want non-nil empty slice", entries)
	}
}
