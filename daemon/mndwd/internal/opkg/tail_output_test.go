package opkg

import (
	"strings"
	"testing"
)

func TestTailOutputShortInputUnchanged(t *testing.T) {
	if got := tailOutput("abc"); got != "abc" {
		t.Fatalf("tailOutput(short) = %q, want %q", got, "abc")
	}
}

func TestTailOutputTruncatesToLastTailBytes(t *testing.T) {
	in := strings.Repeat("x", tailOutputBytes) + "TAIL"
	got := tailOutput(in)

	if len(got) != tailOutputBytes {
		t.Fatalf("len(tailOutput) = %d, want %d", len(got), tailOutputBytes)
	}

	if !strings.HasSuffix(got, "TAIL") {
		t.Fatalf("tailOutput did not keep the newest bytes: %q", got[len(got)-8:])
	}
}

func TestTailOutputBytesVariant(t *testing.T) {
	in := make([]byte, tailOutputBytes+10)

	if got := tailOutput(in); len(got) != tailOutputBytes {
		t.Fatalf("len(tailOutput([]byte)) = %d, want %d", len(got), tailOutputBytes)
	}
}
