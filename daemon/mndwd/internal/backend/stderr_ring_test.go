package backend

import "testing"

func TestStderrRingBoundsBytesAndLines(t *testing.T) {
	ring := NewStderrRing(12, 2)

	ring.Write([]byte("first\nsecond\nthird\n"))

	lines := ring.Lines()

	if len(lines) > 2 {
		t.Fatalf("lines = %#v", lines)
	}

	if len(ring.Bytes()) > 12 {
		t.Fatalf("ring bytes = %d", len(ring.Bytes()))
	}
}

func TestStderrRingKeepsAtMostConfiguredNewlines(t *testing.T) {
	ring := NewStderrRing(0, 2)

	ring.Write([]byte("first\nsecond\nthird\n"))

	if got := ring.Lines(); len(got) != 2 || got[0] != "second" || got[1] != "third" {
		t.Fatalf("lines = %#v", got)
	}
}

func TestStderrRingZeroMaxLinesDoesNotTrim(t *testing.T) {
	ring := NewStderrRing(0, 0)

	ring.Write([]byte("first\nsecond\nthird\n"))

	if got := ring.Lines(); len(got) != 3 {
		t.Fatalf("lines = %#v", got)
	}
}
