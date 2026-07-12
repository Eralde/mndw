package opkg

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

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
	if !slices.Equal(installed, []string{"curl", "ttyd"}) {
		t.Errorf("installed = %v, want [curl ttyd]", installed)
	}

	if err := m.Remove(ctx, []string{"curl"}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	installed, _ = m.ListInstalled(ctx)
	if !slices.Equal(installed, []string{"ttyd"}) {
		t.Errorf("after remove = %v, want [ttyd]", installed)
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
