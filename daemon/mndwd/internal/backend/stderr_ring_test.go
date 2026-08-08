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
