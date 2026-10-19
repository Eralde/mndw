package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestStatusUsesVersionThenFailureThenLock(t *testing.T) {
	store := NewStateStore(t.TempDir())

	if err := store.WriteIntent(Intent{Operation: OperationUpdate, CurrentVersion: "0.0.3", TargetVersion: "0.0.4"}); err != nil {
		t.Fatal(err)
	}

	if got := store.Status("0.0.3", true); got.State != StateInProgress {
		t.Fatalf("in-progress status = %+v", got)
	}

	mustWrite(t, store.failurePath(), "opkg-install-failed\n")

	if got := store.Status("0.0.3", false); got.FailureCode != "opkg-install-failed" || got.State != StateFailed {
		t.Fatalf("failed status = %+v", got)
	}

	if got := store.Status("0.0.4", false); got.State != StateIdle || got.Version != "0.0.4" {
		t.Fatalf("completed status = %+v", got)
	}

	if _, err := os.Stat(store.intentPath()); !os.IsNotExist(err) {
		t.Fatalf("intent remains after completion: %v", err)
	}

	completion, err := store.ConsumeCompletion()
	if err != nil {
		t.Fatal(err)
	}

	if completion.Operation != OperationUpdate || completion.PreviousVersion != "0.0.3" || completion.TargetVersion != "0.0.4" {
		t.Fatalf("completion = %+v", completion)
	}

	if _, err := store.ConsumeCompletion(); err != ErrNoIntent {
		t.Fatalf("second completion read = %v", err)
	}
}

func TestStatusDetectsHelperExitAndUnexpectedVersion(t *testing.T) {
	store := NewStateStore(t.TempDir())

	if err := store.WriteIntent(Intent{Operation: OperationUpdate, CurrentVersion: "0.0.3", TargetVersion: "0.0.4"}); err != nil {
		t.Fatal(err)
	}

	if got := store.Status("0.0.3", false); got.FailureCode != "helper-exited" {
		t.Fatalf("helper exit status = %+v", got)
	}

	if err := store.WriteIntent(Intent{Operation: OperationUpdate, CurrentVersion: "0.0.3", TargetVersion: "0.0.4"}); err != nil {
		t.Fatal(err)
	}

	if got := store.Status("0.0.9", false); got.FailureCode != "unexpected-version" {
		t.Fatalf("unexpected version status = %+v", got)
	}
}

func TestStatusCorruptIntent(t *testing.T) {
	store := NewStateStore(t.TempDir())

	mustWrite(t, store.intentPath(), "not json")

	got := store.Status("0.0.3", false)

	if got.State != StateFailed || got.FailureCode != "state-corrupt" {
		t.Fatalf("corrupt status = %+v", got)
	}
}

func TestRollbackValidation(t *testing.T) {
	store := NewStateStore(t.TempDir())
	symlinkTarget := filepath.Join(t.TempDir(), "target")

	mustWrite(t, symlinkTarget, "target")

	if err := os.MkdirAll(store.rollbackDir(), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := store.RollbackVersion("0.0.4"); got != "" {
		t.Fatalf("missing rollback = %q", got)
	}

	if err := os.Symlink(symlinkTarget, store.rollbackVersionPath()); err != nil {
		t.Fatal(err)
	}

	if got := store.RollbackVersion("0.0.4"); got != "" {
		t.Fatalf("symlink rollback = %q", got)
	}

	if err := os.Remove(store.rollbackVersionPath()); err != nil {
		t.Fatal(err)
	}

	mustWrite(t, store.rollbackVersionPath(), "../escape\n")

	if got := store.RollbackVersion("0.0.4"); got != "" {
		t.Fatalf("invalid rollback = %q", got)
	}

	mustWrite(t, store.rollbackVersionPath(), "0.0.4\n")
	mustWrite(t, filepath.Join(store.rollbackDir(), "mndw-0.0.4.ipk"), "same")

	if got := store.RollbackVersion("0.0.4"); got != "" {
		t.Fatalf("current rollback = %q", got)
	}

	mustWrite(t, store.rollbackVersionPath(), "0.0.3\n")
	mustWrite(t, filepath.Join(store.rollbackDir(), "mndw-0.0.3.ipk"), "previous")

	if got := store.RollbackVersion("0.0.4"); got != "0.0.3" {
		t.Fatalf("valid rollback = %q", got)
	}

	if got, ok := store.RollbackPath("0.0.4"); !ok || got != filepath.Join(store.rollbackDir(), "mndw-0.0.3.ipk") {
		t.Fatalf("rollback path = %q, %v", got, ok)
	}
}
