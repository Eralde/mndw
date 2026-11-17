package opkg

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
)

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

func TestStubListStatusesAndTransitions(t *testing.T) {
	m := New("stub", discard())
	ctx := context.Background()

	result, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	entries := result.Packages
	statuses := map[string]string{}

	for _, entry := range entries {
		statuses[entry.Name] = entry.Status
	}

	want := map[string]string{
		"bash": "installed", "curl": "available", "daemonize": "available",
		"jq": "update_available", "socat": "available", "ttyd": "available",
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

	result, err = m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}

	entries = result.Packages

	for _, entry := range entries {
		if entry.Name == "curl" && (entry.Status != "installed" || entry.Version != "8.0.1-1") {
			t.Errorf("curl after install = %+v", entry)
		}

		if entry.Name == "bash" && entry.Status != "available" {
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
