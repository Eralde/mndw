package opkg

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newExecManagerWithRunner(runner func(context.Context, ...string) (string, int, error)) *execManager {
	return &execManager{logger: discard(), runner: runner, gate: make(chan struct{}, 1)}
}

func TestStubInstallListRemove(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	if err := m.Install(ctx, []string{"curl", "ttyd"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	installed, err := m.ListInstalled(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(installed, []string{"bash", "curl", "jq", "ttyd"}) {
		t.Errorf("installed = %v, want [bash curl jq ttyd]", installed)
	}

	if err := m.Remove(ctx, []string{"curl"}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	installed, _ = m.ListInstalled(ctx)
	if !slices.Equal(installed, []string{"bash", "jq", "ttyd"}) {
		t.Errorf("after remove = %v, want [bash jq ttyd]", installed)
	}
}

func TestStubListAvailableIncludesInstalled(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()
	if err := m.Install(ctx, []string{"myextra"}); err != nil {
		t.Fatal(err)
	}
	avail, _ := m.ListAvailable(ctx)
	if !slices.Contains(avail, "myextra") {
		t.Errorf("available should include installed myextra, got %v", avail)
	}
	if !slices.Contains(avail, "curl") {
		t.Errorf("available should include catalog curl, got %v", avail)
	}
	if !slices.Contains(avail, "bash") || !slices.Contains(avail, "jq") {
		t.Errorf("available should include pre-installed bash and jq, got %v", avail)
	}
}

func TestValidateRejectsBadNames(t *testing.T) {
	m := New("stub", discard())
	err := m.Install(context.Background(), []string{"ok", "BAD NAME"})
	var invalid *InvalidPackageError
	if !errors.As(err, &invalid) {
		t.Fatalf("expected InvalidPackageError, got %v", err)
	}
	if invalid.Name != "BAD NAME" {
		t.Errorf("invalid name = %q", invalid.Name)
	}
}

func TestValidateRejectsEmpty(t *testing.T) {
	m := New("stub", discard())
	if err := m.Install(context.Background(), nil); err == nil {
		t.Fatal("expected error for empty package list")
	}
}

func TestParseNames(t *testing.T) {
	out := "curl - 8.0.1-1 - a tool\nttyd - 1.7.4 - terminal\n\n"
	got := parseNames(out)
	if !slices.Equal(got, []string{"curl", "ttyd"}) {
		t.Errorf("parseNames = %v, want [curl ttyd]", got)
	}
}

func TestParseEntries(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		wantLen int
		wantErr bool
	}{
		{name: "valid with description", output: "curl - 8.0.1-1 - Client URL retrieval utility\r\n", wantLen: 1},
		{name: "valid without description", output: "antiscan2 - 2-alpha18\n", wantLen: 1},
		{name: "separator in description", output: "pkg - 1.0-1 - desc - with separator\n", wantLen: 1},
		{name: "empty description", output: "pkg - 1.0-1 - \n", wantLen: 1},
		{name: "missing version separator", output: "pkg 1.0-1\n", wantErr: true},
		{name: "empty name", output: " - 1.0-1 - desc\n", wantErr: true},
		{name: "empty version", output: "pkg -  - desc\n", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseEntries(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseEntries() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && len(got) != tt.wantLen {
				t.Fatalf("len(parseEntries()) = %d, want %d", len(got), tt.wantLen)
			}
		})
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

	entries, err := newExecManagerWithRunner(runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("len(entries) = %d, want 3", len(entries))
	}
	if entries[0].Name != "curl" || entries[0].Version != "7.55.1-1" || entries[0].Description != "Feed desc" || entries[0].Status != "update_available" || entries[0].NewVersion != "8.0.1-1" {
		t.Errorf("curl entry = %+v", entries[0])
	}
	if entries[1].Name != "orphan" || entries[1].Version != "2.1.0-1" || entries[1].Description != "Custom tool" || entries[1].Status != "installed" || entries[1].NewVersion != "" {
		t.Errorf("orphan entry = %+v", entries[1])
	}
	if entries[2].Name != "socat" || entries[2].Status != "uninstalled" {
		t.Errorf("socat entry = %+v", entries[2])
	}
}

func TestExecListEmptyOutput(t *testing.T) {
	runner := func(_ context.Context, _ ...string) (string, int, error) {
		return "", 0, nil
	}

	entries, err := newExecManagerWithRunner(runner).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if entries == nil || len(entries) != 0 {
		t.Errorf("entries = %#v, want non-nil empty slice", entries)
	}
}

func TestStubListStatusesAndTransitions(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	entries, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	for _, entry := range entries {
		statuses[entry.Name] = entry.Status
	}
	want := map[string]string{
		"bash": "installed", "curl": "uninstalled", "daemonize": "uninstalled",
		"jq": "update_available", "socat": "uninstalled", "ttyd": "uninstalled",
	}
	if !mapsEqual(statuses, want) {
		t.Errorf("statuses = %v, want %v", statuses, want)
	}

	if err := m.Install(ctx, []string{"curl"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Remove(ctx, []string{"bash"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Upgrade(ctx, []string{"jq"}); err != nil {
		t.Fatal(err)
	}
	entries, err = m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name == "curl" && (entry.Status != "installed" || entry.Version != "8.0.1-1") {
			t.Errorf("curl after install = %+v", entry)
		}
		if entry.Name == "bash" && entry.Status != "uninstalled" {
			t.Errorf("bash after remove = %+v", entry)
		}
		if entry.Name == "jq" && (entry.Status != "installed" || entry.Version != "1.7-1" || entry.NewVersion != "") {
			t.Errorf("jq after upgrade = %+v", entry)
		}
	}
}

func mapsEqual(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	for key, value := range want {
		if got[key] != value {
			return false
		}
	}

	return true
}

// TestExecMutationsSerialize verifies mutating operations never run concurrently:
// while the first runner is held open, no other mutation may enter. Channel-driven —
// the only timing element is the negative-assertion window, which can only produce
// a false FAILURE if the gate is broken, never a false pass of a working gate.
func TestExecMutationsSerialize(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	m := &execManager{logger: logger, gate: make(chan struct{}, 1)}
	m.runner = func(_ context.Context, _ ...string) (string, int, error) {
		entered <- struct{}{}
		<-release

		return "", 0, nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Install(context.Background(), []string{"ttyd"}); err != nil {
				t.Errorf("Install: %v", err)
			}
		}()
	}

	<-entered

	select {
	case <-entered:
		t.Fatal("a second mutation entered the runner while the gate was held")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	wg.Wait()

	if got := len(entered); got != 3 {
		t.Fatalf("runner entries after release = %d, want 3", got)
	}
}

// TestExecGateWaitAbortsOnCancel verifies a canceled context aborts a gate wait
// immediately instead of queueing behind a long-running mutation. The holder signals
// gate acquisition from inside its runner — no wall-clock sleeps.
func TestExecGateWaitAbortsOnCancel(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	acquired := make(chan struct{})
	holdRelease := make(chan struct{})
	m := &execManager{logger: logger, gate: make(chan struct{}, 1)}
	m.runner = func(ctx context.Context, _ ...string) (string, int, error) {
		close(acquired)
		select {
		case <-holdRelease:
		case <-ctx.Done():
		}

		return "", 0, nil
	}

	holderDone := make(chan struct{})
	go func() {
		defer close(holderDone)
		_ = m.Install(context.Background(), []string{"ttyd"})
	}()
	<-acquired

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := m.Install(ctx, []string{"daemonize"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Install with canceled ctx = %v, want context.Canceled", err)
	}

	close(holdRelease)
	<-holderDone
}

// TestExecMutationsAbortWhenCanceled pins the contract on every exec mutating
// method: an already-canceled context aborts at the gate, before the runner runs.
func TestExecMutationsAbortWhenCanceled(t *testing.T) {
	m := &execManager{logger: discard(), gate: make(chan struct{}, 1)}
	m.runner = func(_ context.Context, args ...string) (string, int, error) {
		t.Errorf("runner invoked despite canceled context: %v", args)

		return "", 0, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	checks := []struct {
		name string
		call func() error
	}{
		{"Install", func() error { return m.Install(ctx, []string{"ttyd"}) }},
		{"Remove", func() error { return m.Remove(ctx, []string{"ttyd"}) }},
		{"Upgrade", func() error { return m.Upgrade(ctx, []string{"ttyd"}) }},
		{"Update", func() error { return m.Update(ctx) }},
	}
	for _, c := range checks {
		if err := c.call(); !errors.Is(err, context.Canceled) {
			t.Errorf("exec %s with canceled ctx = %v, want context.Canceled", c.name, err)
		}
	}
}

// TestStubHonorsCancellation pins the Manager cancellation contract on EVERY method
// of the stub: each must return the context error once ctx is done.
func TestStubHonorsCancellation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := newStub(logger)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	checks := []struct {
		name string
		call func() error
	}{
		{"Install", func() error { return m.Install(ctx, []string{"ttyd"}) }},
		{"Remove", func() error { return m.Remove(ctx, []string{"ttyd"}) }},
		{"Upgrade", func() error { return m.Upgrade(ctx, []string{"ttyd"}) }},
		{"Update", func() error { return m.Update(ctx) }},
		{"ListInstalled", func() error { _, err := m.ListInstalled(ctx); return err }},
		{"ListAvailable", func() error { _, err := m.ListAvailable(ctx); return err }},
		{"List", func() error { _, err := m.List(ctx); return err }},
	}
	for _, c := range checks {
		if err := c.call(); !errors.Is(err, context.Canceled) {
			t.Errorf("stub %s with canceled ctx = %v, want context.Canceled", c.name, err)
		}
	}
}
