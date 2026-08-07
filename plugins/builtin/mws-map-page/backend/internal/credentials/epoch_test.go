package credentials

import (
	"context"
	"testing"
)

func TestEpochCancelsPreviousAndRejectsStaleWrites(t *testing.T) {
	epoch := NewEpoch()
	first, firstCtx := epoch.Begin(context.Background())
	second, secondCtx := epoch.Begin(context.Background())
	if first != 1 || second != 2 {
		t.Fatalf("epochs = %d, %d", first, second)
	}
	if firstCtx.Err() == nil {
		t.Fatal("first context was not cancelled")
	}
	if secondCtx.Err() != nil || !epoch.CurrentIs(second) || epoch.CurrentIs(first) {
		t.Fatal("epoch currentness incorrect")
	}
}
