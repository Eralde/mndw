package main

import (
	"os"
	"strings"
	"testing"
)

func TestSetBackendProcessNameChangesAndRestoresComm(t *testing.T) {
	const commPath = "/proc/self/comm"

	original, err := os.ReadFile(commPath)
	if err != nil {
		t.Fatalf("read original process name: %v", err)
	}

	original = []byte(strings.TrimSuffix(string(original), "\n"))

	t.Cleanup(func() {
		if err := os.WriteFile(commPath, original, 0); err != nil {
			t.Errorf("restore original process name: %v", err)
		}
	})

	setBackendProcessName("mndw-test")

	got, err := os.ReadFile(commPath)
	if err != nil {
		t.Fatalf("read updated process name: %v", err)
	}

	if strings.TrimSpace(string(got)) != "mndw-test" {
		t.Fatalf("process name = %q, want %q", strings.TrimSpace(string(got)), "mndw-test")
	}
}
