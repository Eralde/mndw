package output

import (
	"strings"
	"testing"
)

func TestTailShortInputUnchanged(t *testing.T) {
	if got := Tail("abc"); got != "abc" {
		t.Fatalf("Tail(short) = %q, want %q", got, "abc")
	}
}

func TestTailTruncatesToLastTailBytes(t *testing.T) {
	in := strings.Repeat("x", TailBytes) + "TAIL"
	got := Tail(in)

	if len(got) != TailBytes {
		t.Fatalf("len(Tail) = %d, want %d", len(got), TailBytes)
	}

	if !strings.HasSuffix(got, "TAIL") {
		t.Fatalf("Tail did not keep the newest bytes: %q", got[len(got)-8:])
	}
}

func TestTailBytesVariant(t *testing.T) {
	in := make([]byte, TailBytes+10)

	if got := Tail(in); len(got) != TailBytes {
		t.Fatalf("len(Tail([]byte)) = %d, want %d", len(got), TailBytes)
	}
}
