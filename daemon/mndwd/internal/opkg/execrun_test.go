package opkg

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A failing command's stderr must reach the returned output — opkg reports its
// failure reason there (e.g. "Could not lock /opt/var/lock/opkg.lock"), and the
// callers log that output tail on failure.
func TestExecRunNonZeroExitIncludesStderr(t *testing.T) {
	out, exitCode, err := execRun(context.Background(), "sh", "-c", "echo from-stdout; echo from-stderr >&2; exit 7")
	if err != nil {
		t.Fatalf("execRun: %v", err)
	}

	if exitCode != 7 {
		t.Errorf("exitCode = %d, want 7", exitCode)
	}

	if !strings.Contains(out, "from-stdout") {
		t.Errorf("output missing stdout content: %q", out)
	}

	if !strings.Contains(out, "from-stderr") {
		t.Errorf("output missing stderr content: %q", out)
	}
}

// A successful command's output must stay stderr-free: exit-0 output is parsed
// (opkg list / list-installed), so warnings on stderr must not corrupt it.
func TestExecRunZeroExitExcludesStderr(t *testing.T) {
	out, exitCode, err := execRun(context.Background(), "sh", "-c", "echo from-stdout; echo from-stderr >&2")
	if err != nil {
		t.Fatalf("execRun: %v", err)
	}

	if exitCode != 0 {
		t.Errorf("exitCode = %d, want 0", exitCode)
	}

	if out != "from-stdout\n" {
		t.Errorf("output = %q, want %q", out, "from-stdout\n")
	}
}

// TestExecRunReturnsPromptlyOnCancel pins the ungated read path's half of the
// cancellation contract: CommandContext must kill the child once ctx is done.
func TestExecRunReturnsPromptlyOnCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)

	defer cancel()

	start := time.Now()
	_, _, err := execRun(ctx, "sleep", "5")
	if err == nil {
		t.Fatal("execRun with expiring ctx returned nil error")
	}

	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("execRun returned after %v; the child was not killed on cancel", elapsed)
	}
}
