package timekeeper

import (
	"testing"
)

func TestCaseConfigTimeThenNTP(t *testing.T) {
	k := newTestKeeper(nil)
	base := testUTC().UnixMilli()

	k.ObserveClock(Reading{BootMs: 100_000, WallMs: base + 100_000})
	k.ObserveClock(Reading{BootMs: 110_000, WallMs: base + 710_000})

	reading := Reading{BootMs: 110_500, WallMs: base + 710_500}
	out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 1))

	if out.Decision != Accept {
		t.Fatalf("restored config time then NTP: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	if out.State.OffsetMs != base+600_000 {
		t.Fatalf("OffsetMs = %d, want config-time jump offset %d", out.State.OffsetMs, base+600_000)
	}
}

func TestCaseScheduledResync(t *testing.T) {
	base := testUTC().UnixMilli()
	saved := savedState("pool.ntp.org", 10_000, base)
	k := newTestKeeper(&saved)
	reading := Reading{BootMs: 120_000, WallMs: base + 122_500 + 120_000}
	out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 20))

	if out.Decision != Accept {
		t.Fatalf("scheduled resync: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	if out.State.OffsetMs != base+122_500 {
		t.Fatalf("OffsetMs = %d, want drift-adjusted %d", out.State.OffsetMs, base+122_500)
	}
}

func TestCaseManualChange(t *testing.T) {
	base := testUTC().UnixMilli()
	saved := savedState("pool.ntp.org", 10_000, base)
	k := newTestKeeper(&saved)
	reading := Reading{BootMs: 100_000, WallMs: base + 500_000 + 100_000}
	manual := goodEvidence("pool.ntp.org", 90)
	manual.UserTime = true
	out := k.Evaluate(reading, reading, manual)

	if out.Decision != Ignore {
		t.Fatalf("manual time evidence: Decision = %v, want Ignore", out.Decision)
	}

	if state, ok := k.Anchored(); !ok || state.OffsetMs != saved.OffsetMs {
		t.Fatalf("Anchored() = (%+v, %t), want original offset %d", state, ok, saved.OffsetMs)
	}

	out = k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 80))

	if out.Decision != Accept {
		t.Fatalf("post-manual sync: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestCaseExternalChangeAfterWindow(t *testing.T) {
	saved := savedState("pool.ntp.org", 100_000, testUTC().UnixMilli())
	k := newTestKeeper(&saved)

	armClockChange(k, 200_000)

	reading := Reading{BootMs: 200_100, WallMs: testUTC().UnixMilli() + 200_100}
	out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 100))

	if out.Decision != Ignore {
		t.Fatalf("same evidence after external change: Decision = %v, want Ignore", out.Decision)
	}

	out = k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 0))

	if out.Decision != Accept {
		t.Fatalf("next synchronization: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestCaseCloudTime(t *testing.T) {
	status := goodEvidence("cloud.time", 0)
	status.NDSSTime = true
	reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}
	out := newTestKeeper(nil).Evaluate(reading, reading, status)

	if out.Decision != Ignore {
		t.Fatalf("cloud time: Decision = %v, want Ignore", out.Decision)
	}
}

func TestCaseFailedResync(t *testing.T) {
	status := goodEvidence("pool.ntp.org", 0)
	status.Accurate = false
	status.Server = ""
	reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}
	out := newTestKeeper(nil).Evaluate(reading, reading, status)

	if out.Decision != Ignore {
		t.Fatalf("failed resync: Decision = %v, want Ignore", out.Decision)
	}
}

func TestCaseWrongThenCorrectedNTP(t *testing.T) {
	base := testUTC().UnixMilli()
	k := newTestKeeper(nil)
	wrong := Reading{BootMs: 100_000, WallMs: base + 50_000_000 + 100_000}
	out := k.Evaluate(wrong, wrong, goodEvidence("pool.ntp.org", 10))

	if out.Decision != Accept {
		t.Fatalf("wrong NTP: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	k.Commit(out.State)

	corrected := Reading{BootMs: 200_000, WallMs: base + 200_000}
	out = k.Evaluate(corrected, corrected, goodEvidence("pool.ntp.org", 100))

	if out.Decision != Accept {
		t.Fatalf("corrected NTP: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	k.Commit(out.State)

	if state, ok := k.Anchored(); !ok || state.OffsetMs != base {
		t.Fatalf("final Anchored() = (%+v, %t), want corrected offset %d", state, ok, base)
	}
}

func TestCaseExternalChangeBeforeFirstAcceptance(t *testing.T) {
	k := newTestKeeper(nil)

	armClockChange(k, 200_000)

	late := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}
	out := k.Evaluate(late, late, goodEvidence("pool.ntp.org", 0))

	if out.Decision != Reject {
		t.Fatalf("stale first evidence: Decision = %v, want Reject (%s)", out.Decision, out.Reason)
	}

	current := Reading{BootMs: 200_100, WallMs: testUTC().UnixMilli() + 200_100}
	out = k.Evaluate(current, current, goodEvidence("pool.ntp.org", 0))

	if out.Decision != Accept {
		t.Fatalf("next sync after stale evidence: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestCaseManualChangeBeforeFirstAcceptance(t *testing.T) {
	k := newTestKeeper(nil)
	reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 500_000 + 100_000}
	manual := goodEvidence("pool.ntp.org", 10)
	manual.UserTime = true
	out := k.Evaluate(reading, reading, manual)

	if out.Decision != Ignore {
		t.Fatalf("manual time before first acceptance: Decision = %v, want Ignore", out.Decision)
	}

	if _, ok := k.Anchored(); ok {
		t.Fatal("manual time evidence anchored the clock")
	}

	out = k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 10))

	if out.Decision != Accept {
		t.Fatalf("later NTP evidence: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestAppendixASyncSteppedClock(t *testing.T) {
	base := testUTC().UnixMilli()
	k := newTestKeeper(nil)

	k.ObserveClock(Reading{BootMs: 100_000, WallMs: base + 100_000})
	k.ObserveClock(Reading{BootMs: 110_000, WallMs: base + 115_000})

	stepped := Reading{BootMs: 110_500, WallMs: base + 115_500}
	out := k.Evaluate(stepped, stepped, goodEvidence("pool.ntp.org", 1))

	if out.Decision != Accept {
		t.Fatalf("stepped sync: Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	k.Commit(out.State)

	k.ObserveClock(Reading{BootMs: 120_000, WallMs: base + 126_000})

	changed := Reading{BootMs: 120_500, WallMs: base + 126_500}
	out = k.Evaluate(changed, changed, goodEvidence("pool.ntp.org", 11))

	if out.Decision != Ignore {
		t.Fatalf("same identity after later external change: Decision = %v, want Ignore", out.Decision)
	}
}

func TestAppendixASyncDidNotStepClock(t *testing.T) {
	for _, tt := range []struct {
		name       string
		lastChange int64
		want       Decision
	}{
		{name: "external change at plus 35 seconds", lastChange: 135_000, want: Accept},
		{name: "external change at plus 41 seconds", lastChange: 141_000, want: Reject},
	} {
		t.Run(tt.name, func(t *testing.T) {
			k := newTestKeeper(nil)

			armClockChange(k, tt.lastChange)

			reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}
			out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 0))

			if out.Decision != tt.want {
				t.Fatalf("Evaluate().Decision = %v, want %v (%s)", out.Decision, tt.want, out.Reason)
			}
		})
	}
}
