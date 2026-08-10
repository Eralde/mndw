package ptr

import "testing"

func TestToReturnsPointerToValue(t *testing.T) {
	t.Parallel()

	value := To(42)
	if value == nil {
		t.Fatal("To() returned nil")
	}
	if *value != 42 {
		t.Fatalf("*To() = %d, want 42", *value)
	}
}

func TestToSupportsNamedTypes(t *testing.T) {
	t.Parallel()

	type status string
	value := To(status("ready"))
	if *value != "ready" {
		t.Fatalf("*To() = %q, want ready", *value)
	}
}
