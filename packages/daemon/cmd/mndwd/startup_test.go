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

// failFirstManager fails the first Install call and records every attempt.
type failFirstManager struct {
	opkg.Manager
	calls [][]string
}

func (m *failFirstManager) Install(_ context.Context, packages []string) error {
	m.calls = append(m.calls, packages)
	if len(m.calls) == 1 {
		return errors.New("simulated opkg failure")
	}

	return nil
}

func TestInstallBuiltinDepsContinuesAfterFailure(t *testing.T) {
	builtinDir := t.TempDir()
	// ListBuiltins walks the dir in lexical order, so a-widget installs first.
	writeBuiltin(t, builtinDir, "a-widget", []string{"socat"})
	writeBuiltin(t, builtinDir, "b-widget", []string{"ttyd"})

	reg := builtinRegistry(t, builtinDir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := &failFirstManager{}

	installBuiltinDeps(reg, mgr, logger)

	if len(mgr.calls) != 2 {
		t.Fatalf("expected 2 install attempts, got %d: %v", len(mgr.calls), mgr.calls)
	}
	if fmt.Sprint(mgr.calls[0]) != "[socat]" || fmt.Sprint(mgr.calls[1]) != "[ttyd]" {
		t.Errorf("unexpected install calls: %v", mgr.calls)
	}
}
