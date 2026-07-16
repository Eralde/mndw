package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"mndwd/internal/opkg"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// writeBuiltin creates a builtin plugin dir with a minimal valid widget manifest
// declaring the given opkg dependencies (none when pkgs is empty).
func writeBuiltin(t *testing.T, builtinDir, name string, pkgs []string) {
	t.Helper()

	m := map[string]any{
		"manifestVersion": 2,
		"name":            name,
		"version":         "0.1.0",
		"type":            "widget",
		"label":           name,
		"entry":           "index.js",
		"size":            map[string]int{"w": 4, "h": 3},
	}
	if len(pkgs) > 0 {
		m["backend"] = map[string]any{"opkg": pkgs}
	}

	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(builtinDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func builtinRegistry(t *testing.T, builtinDir string) *registry.Registry {
	t.Helper()

	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}

	return registry.New(store, filepath.Join(root, "user-plugins"), builtinDir)
}

func TestInstallBuiltinDepsInstallsDeclaredPackages(t *testing.T) {
	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd", "daemonize"})
	writeBuiltin(t, builtinDir, "clock-widget", nil)

	reg := builtinRegistry(t, builtinDir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := opkg.New("stub", logger)

	installBuiltinDeps(reg, mgr, logger)

	installed, err := mgr.ListInstalled(context.Background())
	if err != nil {
		t.Fatalf("ListInstalled: %v", err)
	}
	for _, want := range []string{"ttyd", "daemonize"} {
		if !slices.Contains(installed, want) {
			t.Errorf("package %q not installed; installed = %v", want, installed)
		}
	}
}

// setRetryDelays overrides the between-attempt waits for the test's duration.
func setRetryDelays(t *testing.T, delays []time.Duration) {
	t.Helper()
	restore := opkgInstallRetryDelays
	opkgInstallRetryDelays = delays
	t.Cleanup(func() { opkgInstallRetryDelays = restore })
}

// flakyManager fails the first `failures` Install calls (a transient condition such
// as the opkg lock still held by the parent `opkg install mndw...` during postinst)
// and records every attempt.
type flakyManager struct {
	opkg.Manager
	failures int
	calls    [][]string
}

func (m *flakyManager) Install(_ context.Context, packages []string) error {
	m.calls = append(m.calls, packages)
	if len(m.calls) <= m.failures {
		return errors.New("simulated transient opkg failure")
	}

	return nil
}

func TestInstallBuiltinDepsRetriesTransientFailure(t *testing.T) {
	setRetryDelays(t, []time.Duration{0, 0})

	builtinDir := t.TempDir()
	writeBuiltin(t, builtinDir, "ttyd-widget", []string{"ttyd", "daemonize"})

	reg := builtinRegistry(t, builtinDir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := &flakyManager{failures: 2}

	installBuiltinDeps(reg, mgr, logger)

	if len(mgr.calls) != 3 {
		t.Fatalf("expected 3 install attempts (2 failures + 1 success), got %d: %v", len(mgr.calls), mgr.calls)
	}
}

// stuckManager fails every Install for a marked package and records every attempt.
type stuckManager struct {
	opkg.Manager
	failing map[string]bool
	calls   [][]string
}

func (m *stuckManager) Install(_ context.Context, packages []string) error {
	m.calls = append(m.calls, packages)
	for _, p := range packages {
		if m.failing[p] {
			return errors.New("simulated persistent opkg failure")
		}
	}

	return nil
}

func TestInstallBuiltinDepsContinuesAfterPersistentFailure(t *testing.T) {
	setRetryDelays(t, []time.Duration{0})

	builtinDir := t.TempDir()
	// ListBuiltins walks the dir in lexical order, so a-widget installs first.
	writeBuiltin(t, builtinDir, "a-widget", []string{"socat"})
	writeBuiltin(t, builtinDir, "b-widget", []string{"ttyd"})

	reg := builtinRegistry(t, builtinDir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := &stuckManager{failing: map[string]bool{"socat": true}}

	installBuiltinDeps(reg, mgr, logger)

	// a-widget exhausts its 2 attempts (1 + 1 retry), then b-widget still installs.
	want := "[[socat] [socat] [ttyd]]"
	if fmt.Sprint(mgr.calls) != want {
		t.Errorf("install calls = %v, want %s", mgr.calls, want)
	}
}
