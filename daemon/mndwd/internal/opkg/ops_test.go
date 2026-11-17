package opkg

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProtectedPackageRejectedBeforeRunner(t *testing.T) {
	calls := 0
	m := newExecManagerWithRunner(t, func(context.Context, ...string) (string, int, error) {
		calls++

		return "", 0, nil
	})
	err := m.Remove(context.Background(), []string{"mndw"})
	var protected *ProtectedPackageError

	if !errors.As(err, &protected) || calls != 0 {
		t.Fatalf("error = %v, calls = %d", err, calls)
	}
}

// TestExecRemoveDetectsDependencyConflictOnZeroExit pins the fix: opkg refuses a
// removal with a reverse-dependency warning while exiting 0, and Remove must surface
// that as a DependencyConflictError instead of reporting success.
func TestExecRemoveDetectsDependencyConflictOnZeroExit(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return "Package curl is depended upon by packages:\n\twget-ssl\n\tThese might cease to work if package curl is removed.\n", 0, nil
	}
	m := newExecManagerWithRunner(t, runner)
	err := m.Remove(context.Background(), []string{"curl"})
	var conflict *DependencyConflictError

	if !errors.As(err, &conflict) {
		t.Fatalf("Remove error = %v, want *DependencyConflictError", err)
	}

	if conflict.Package != "curl" || !slices.Equal(conflict.DependedBy, []string{"wget-ssl"}) {
		t.Fatalf("conflict = %+v", conflict)
	}
}

// TestExecRemoveDetectsDependencyConflictOnNonZeroExit covers the device's opkg,
// which exits non-zero and prints the reverse-dependency warning (via its "Collected
// errors" section) to stderr. Remove must surface the typed conflict rather than the
// generic "opkg remove exited N" error.
func TestExecRemoveDetectsDependencyConflictOnNonZeroExit(t *testing.T) {
	out := "Collected errors:\n" +
		" * print_dependents_warning: Package curl is depended upon by packages:\n" +
		" * print_dependents_warning: \twget-ssl\n" +
		" * print_dependents_warning: \taria2\n" +
		" * print_dependents_warning: These might cease to work if package curl is removed.\n" +
		" * print_dependents_warning: Force removal of this package via --force-depends\n"
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return out, 255, nil
	}
	m := newExecManagerWithRunner(t, runner)
	err := m.Remove(context.Background(), []string{"curl"})
	var conflict *DependencyConflictError

	if !errors.As(err, &conflict) {
		t.Fatalf("Remove error = %v, want *DependencyConflictError", err)
	}

	if conflict.Package != "curl" || !slices.Equal(conflict.DependedBy, []string{"wget-ssl", "aria2"}) {
		t.Fatalf("conflict = %+v", conflict)
	}
}

func TestExecRemoveSucceedsWithoutDependents(t *testing.T) {
	runner := func(_ context.Context, args ...string) (string, int, error) {
		if strings.Join(args, " ") != "opkg remove curl" {
			return "", 0, errors.New("unexpected command: " + strings.Join(args, " "))
		}

		return "Removing package curl from root...\n", 0, nil
	}

	if err := newExecManagerWithRunner(t, runner).Remove(context.Background(), []string{"curl"}); err != nil {
		t.Fatalf("Remove = %v, want nil", err)
	}
}

// TestExecMutationsSerialize verifies mutating operations never run concurrently:
// while the first runner is held open, no other mutation may enter. Channel-driven —
// the only timing element is the negative-assertion window, which can only produce
// a false FAILURE if the gate is broken, never a false pass of a working gate.
func TestExecMutationsSerialize(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	stateDir := t.TempDir()
	m := &execManager{
		logger:     logger,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
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
	stateDir := t.TempDir()
	m := &execManager{
		logger:     logger,
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
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
	stateDir := t.TempDir()
	m := &execManager{
		logger:     discard(),
		gate:       make(chan struct{}, 1),
		stateDir:   stateDir,
		pendingDir: filepath.Join(stateDir, "pending"),
		lockPath:   filepath.Join(stateDir, "opkg.lock"),
	}
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
