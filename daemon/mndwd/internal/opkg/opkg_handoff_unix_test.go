//go:build !windows

package opkg

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLeaseHandoffKeepsFlockUntilChildCopyCloses(t *testing.T) {
	stateDir := t.TempDir()
	lockPath := filepath.Join(stateDir, "opkg.lock")
	m := &execManager{
		logger:     discard(),
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   lockPath,
	}

	lease, err := m.acquireMutation(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}

	childFD, err := unix.Dup(int(lease.File().Fd()))
	if err != nil {
		t.Fatal(err)
	}

	if err := lease.CommitHandoff(); err != nil {
		t.Fatal(err)
	}

	if _, err := m.acquireMutation(context.Background(), false); !errors.Is(err, ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}

	if err := unix.Close(childFD); err != nil {
		t.Fatal(err)
	}

	released, err := m.acquireMutation(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}

	if err := released.Abort(); err != nil {
		t.Fatal(err)
	}
}
