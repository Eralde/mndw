package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCleanupStackRunsNewestFirst(t *testing.T) {
	var order []string
	var stack cleanupStack

	for _, name := range []string{"runtime", "session", "telemetry", "events"} {
		name := name

		stack.push(name, func() error {
			order = append(order, name)

			return nil
		})
	}

	if err := stack.closeAll(); err != nil {
		t.Fatal(err)
	}

	if want := []string{"events", "telemetry", "session", "runtime"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("close order = %v, want %v", order, want)
	}
}

func TestCleanupStackRunsEveryCloserAndJoinsErrors(t *testing.T) {
	errFirst := errors.New("first failed")
	errLast := errors.New("last failed")
	ran := 0
	var stack cleanupStack

	stack.push("first", func() error { ran++; return errFirst })

	stack.push("middle", func() error { ran++; return nil })

	stack.push("last", func() error { ran++; return errLast })

	err := stack.closeAll()

	if ran != 3 {
		t.Fatalf("closers run = %d, want 3", ran)
	}

	if !errors.Is(err, errFirst) || !errors.Is(err, errLast) {
		t.Fatalf("closeAll error = %v, want both closer errors joined", err)
	}

	if !strings.Contains(err.Error(), "first: first failed") || !strings.Contains(err.Error(), "last: last failed") {
		t.Fatalf("closeAll error = %q, want each error prefixed with its closer name", err)
	}
}

func TestCleanupStackSecondCloseIsNoop(t *testing.T) {
	calls := 0
	var stack cleanupStack

	stack.push("once", func() error { calls++; return nil })

	_ = stack.closeAll()
	_ = stack.closeAll()

	if calls != 1 {
		t.Fatalf("closer ran %d times, want 1", calls)
	}
}

func TestCleanupStackEmptyIsNil(t *testing.T) {
	var stack cleanupStack

	if err := stack.closeAll(); err != nil {
		t.Fatalf("empty closeAll = %v, want nil", err)
	}
}
