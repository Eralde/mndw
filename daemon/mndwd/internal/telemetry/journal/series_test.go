package journal

import (
	"testing"
	"time"
)

func TestStepForSeries(t *testing.T) {
	for _, series := range []uint16{1, 2, 99} {
		if got := StepForSeries(series); got != 3*time.Minute {
			t.Errorf("StepForSeries(%d) = %s, want %s", series, got, 3*time.Minute)
		}
	}
}
