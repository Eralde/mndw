package ring

import (
	"errors"
	"testing"
)

func TestLockIsExclusive(t *testing.T) {
	dir := t.TempDir()
	release, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock first: %v", err)
	}

	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("Lock second error = %v, want ErrLocked", err)
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}

	releaseAgain, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock after release: %v", err)
	}

	if err := releaseAgain(); err != nil {
		t.Fatalf("release again: %v", err)
	}
}
