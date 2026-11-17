package opkg

import (
	"context"
	"errors"
	"testing"
)

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
