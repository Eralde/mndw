package timekeeper

import (
	"testing"
	"time"
)

func TestBracketBoundaries(t *testing.T) {
	base := testUTC().UnixMilli()
	tests := []struct {
		name   string
		before Reading
		after  Reading
		want   Decision
	}{
		{
			name:   "boot exactly one second",
			before: Reading{BootMs: 0, WallMs: base},
			after:  Reading{BootMs: 1000, WallMs: base + 1000},
			want:   Accept,
		},
		{
			name:   "boot over one second",
			before: Reading{BootMs: 0, WallMs: base},
			after:  Reading{BootMs: 1001, WallMs: base + 1001},
			want:   Retry,
		},
		{
			name:   "skew exactly one hundred milliseconds",
			before: Reading{BootMs: 0, WallMs: base},
			after:  Reading{BootMs: 100, WallMs: base + 200},
			want:   Accept,
		},
		{
			name:   "skew over one hundred milliseconds",
			before: Reading{BootMs: 0, WallMs: base},
			after:  Reading{BootMs: 100, WallMs: base + 201},
			want:   Retry,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := newTestKeeper(nil).Evaluate(tt.before, tt.after, goodEvidence("pool.ntp.org", 0))

			if got.Decision != tt.want {
				t.Fatalf("Evaluate().Decision = %v, want %v (%s)", got.Decision, tt.want, got.Reason)
			}
		})
	}
}

func TestOffsetUsesBracketMidpoint(t *testing.T) {
	wall := testUTC().UnixMilli()
	before := Reading{BootMs: 1000, WallMs: wall}
	after := Reading{BootMs: 1600, WallMs: wall + 600}
	out := newTestKeeper(nil).Evaluate(before, after, goodEvidence("pool.ntp.org", 3))

	if out.Decision != Accept {
		t.Fatalf("Evaluate().Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	if out.State.OffsetMs != wall-1000 {
		t.Fatalf("OffsetMs = %d, want %d", out.State.OffsetMs, wall-1000)
	}

	if out.State.SyncStartBootMs != 1300-3_000 {
		t.Fatalf("SyncStartBootMs = %d, want %d", out.State.SyncStartBootMs, 1300-3_000)
	}
}

func TestFreshnessBoundary(t *testing.T) {
	const syncStart = int64(1000)

	for _, tt := range []struct {
		name       string
		lastChange int64
		want       Decision
	}{
		{name: "at attempt plus clock check", lastChange: syncStart + 40_000, want: Accept},
		{name: "one millisecond after window", lastChange: syncStart + 40_001, want: Reject},
	} {
		t.Run(tt.name, func(t *testing.T) {
			k := newTestKeeper(nil)

			armClockChange(k, tt.lastChange)

			reading := Reading{BootMs: syncStart, WallMs: testUTC().UnixMilli() + syncStart}
			out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 0))

			if out.Decision != tt.want {
				t.Fatalf("Evaluate().Decision = %v, want %v (%s)", out.Decision, tt.want, out.Reason)
			}
		})
	}

	out := newTestKeeper(nil).Evaluate(
		Reading{BootMs: syncStart, WallMs: testUTC().UnixMilli() + syncStart},
		Reading{BootMs: syncStart, WallMs: testUTC().UnixMilli() + syncStart},
		goodEvidence("pool.ntp.org", 0),
	)

	if out.Decision != Accept {
		t.Fatalf("Evaluate() without observed change = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestIdentityTolerance(t *testing.T) {
	saved := savedState("pool.ntp.org", 1000, testUTC().UnixMilli())

	for _, tt := range []struct {
		name  string
		start int64
		want  Decision
	}{
		{name: "exactly two seconds is same", start: 3000, want: Ignore},
		{name: "over two seconds is new", start: 3001, want: Accept},
	} {
		t.Run(tt.name, func(t *testing.T) {
			reading := Reading{BootMs: tt.start + 97_000, WallMs: testUTC().UnixMilli() + tt.start + 97_000}
			out := newTestKeeper(&saved).Evaluate(reading, reading, goodEvidence("pool.ntp.org", 97))

			if out.Decision != tt.want {
				t.Fatalf("Evaluate().Decision = %v, want %v (%s)", out.Decision, tt.want, out.Reason)
			}
		})
	}
}

func TestServerChangeIsNewEvidence(t *testing.T) {
	saved := savedState("old.pool", 1000, testUTC().UnixMilli())
	reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}
	out := newTestKeeper(&saved).Evaluate(reading, reading, goodEvidence("new.pool", 99))

	if out.Decision != Accept {
		t.Fatalf("Evaluate().Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	if out.State.SyncStartBootMs != saved.SyncStartBootMs {
		t.Fatalf("SyncStartBootMs = %d, want unchanged %d", out.State.SyncStartBootMs, saved.SyncStartBootMs)
	}
}

func TestFiltersRejectOutOfRangeUTC(t *testing.T) {
	cfg := DefaultConfig()

	for _, tt := range []struct {
		name string
		wall time.Time
		want Decision
	}{
		{name: "below minimum", wall: cfg.MinValidUTC.Add(-time.Millisecond), want: Reject},
		{name: "minimum accepted", wall: cfg.MinValidUTC, want: Accept},
		{name: "above maximum", wall: cfg.MaxValidUTC.Add(time.Millisecond), want: Reject},
	} {
		t.Run(tt.name, func(t *testing.T) {
			midWall := tt.wall.UnixMilli()
			reading := Reading{BootMs: 1000, WallMs: midWall}
			out := newTestKeeper(nil).Evaluate(reading, reading, goodEvidence("pool.ntp.org", 0))

			if out.Decision != tt.want {
				t.Fatalf("Evaluate().Decision = %v, want %v (%s)", out.Decision, tt.want, out.Reason)
			}
		})
	}
}

func TestClockCheckThreshold(t *testing.T) {
	saved := savedState("pool.ntp.org", 1, testUTC().UnixMilli()+900_000)
	base := Reading{BootMs: 0, WallMs: testUTC().UnixMilli()}
	k := newTestKeeper(&saved)

	k.ObserveClock(base)

	if k.WantPoll(base, TriggerClockCheck) {
		t.Fatal("first clock observation compared against saved offset")
	}

	exact := Reading{BootMs: 10_000, WallMs: base.WallMs + 10_100}

	k.ObserveClock(exact)

	if k.WantPoll(exact, TriggerClockCheck) {
		t.Fatal("100 ms clock change armed a poll")
	}

	if k.lastChangeBootMs != nil {
		t.Fatalf("lastChangeBootMs = %v, want nil", *k.lastChangeBootMs)
	}

	changed := newTestKeeper(&saved)

	changed.ObserveClock(base)

	jump := Reading{BootMs: 10_000, WallMs: base.WallMs + 10_101}

	changed.ObserveClock(jump)

	if !changed.WantPoll(jump, TriggerClockCheck) {
		t.Fatal("101 ms clock change did not arm a poll")
	}

	if changed.lastChangeBootMs == nil || *changed.lastChangeBootMs != jump.BootMs {
		t.Fatalf("lastChangeBootMs = %v, want %d", changed.lastChangeBootMs, jump.BootMs)
	}
}

func TestPollSchedule(t *testing.T) {
	unanchored := newTestKeeper(nil)

	if !unanchored.WantPoll(Reading{}, TriggerTick) {
		t.Fatal("unanchored tick did not poll")
	}

	if unanchored.WantPoll(Reading{}, TriggerClockCheck) {
		t.Fatal("unanchored clock check polled without a clock change")
	}

	saved := savedState("pool.ntp.org", 1000, testUTC().UnixMilli())
	anchored := newTestKeeper(&saved)

	for _, trigger := range []Trigger{TriggerTick, TriggerClockCheck} {
		if anchored.WantPoll(Reading{BootMs: 59 * 60_000}, trigger) {
			t.Fatalf("anchored poll fired before one hour for trigger %v", trigger)
		}

		if !anchored.WantPoll(Reading{BootMs: 60 * 60_000}, trigger) {
			t.Fatalf("anchored poll did not fire at one hour for trigger %v", trigger)
		}
	}

	retry := newTestKeeper(&saved)
	out := retry.Evaluate(
		Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000},
		Reading{BootMs: 101_001, WallMs: testUTC().UnixMilli() + 101_001},
		goodEvidence("new.pool", 1),
	)

	if out.Decision != Retry {
		t.Fatalf("Evaluate().Decision = %v, want Retry", out.Decision)
	}

	if !retry.WantPoll(Reading{BootMs: 102_000}, TriggerClockCheck) {
		t.Fatal("bracket Retry did not schedule next clock-check poll")
	}
}

func TestPollFailedSchedule(t *testing.T) {
	saved := savedState("pool.ntp.org", 1000, testUTC().UnixMilli())
	k := newTestKeeper(&saved)
	due := Reading{BootMs: int64(time.Hour / time.Millisecond)}

	k.PollFailed(due)

	if k.WantPoll(due, TriggerTick) || k.WantPoll(due, TriggerClockCheck) {
		t.Fatal("hourly source error caused an immediate retry")
	}

	if !k.WantPoll(Reading{BootMs: due.BootMs + int64(time.Hour/time.Millisecond)}, TriggerTick) {
		t.Fatal("hourly source error did not schedule next hourly poll")
	}

	clockChange := newTestKeeper(&saved)
	base := Reading{BootMs: 0, WallMs: testUTC().UnixMilli()}

	clockChange.ObserveClock(base)

	changed := Reading{BootMs: 10_000, WallMs: base.WallMs + 10_101}

	clockChange.ObserveClock(changed)
	clockChange.PollFailed(changed)

	if !clockChange.WantPoll(changed, TriggerClockCheck) {
		t.Fatal("source error cleared clock-change trigger")
	}

	out := clockChange.Evaluate(changed, changed, goodEvidence("new.pool", 0))

	if out.Decision != Accept {
		t.Fatalf("Evaluate().Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}

	if clockChange.WantPoll(changed, TriggerClockCheck) {
		t.Fatal("decoded response did not clear clock-change trigger")
	}

	retry := newTestKeeper(&saved)
	out = retry.Evaluate(
		Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000},
		Reading{BootMs: 101_001, WallMs: testUTC().UnixMilli() + 101_001},
		goodEvidence("new.pool", 1),
	)

	if out.Decision != Retry {
		t.Fatalf("Evaluate().Decision = %v, want Retry", out.Decision)
	}

	retry.PollFailed(Reading{BootMs: 102_000})

	if !retry.WantPoll(Reading{BootMs: 103_000}, TriggerClockCheck) {
		t.Fatal("source error cleared outstanding bracket retry")
	}
}

func TestBlockedEvaluationIgnores(t *testing.T) {
	k := newTestKeeper(nil)
	reading := Reading{BootMs: 100_000, WallMs: testUTC().UnixMilli() + 100_000}

	k.SetBlocked(true)

	out := k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 1))

	if out.Decision != Ignore {
		t.Fatalf("blocked Evaluate().Decision = %v, want Ignore", out.Decision)
	}

	k.SetBlocked(false)

	out = k.Evaluate(reading, reading, goodEvidence("pool.ntp.org", 1))

	if out.Decision != Accept {
		t.Fatalf("unblocked Evaluate().Decision = %v, want Accept (%s)", out.Decision, out.Reason)
	}
}

func TestSavedStateOfOtherBootIgnored(t *testing.T) {
	saved := savedState("pool.ntp.org", 1000, testUTC().UnixMilli())
	bootID := testBootID()
	bootID[0]++
	k := New(DefaultConfig(), bootID, &saved)

	if _, ok := k.Anchored(); ok {
		t.Fatal("Anchored() = true for saved state from another boot")
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.ClockCheckEvery != 10*time.Second || cfg.ClockChangeThreshold != 100*time.Millisecond ||
		cfg.BracketMaxBoot != time.Second || cfg.BracketMaxSkew != 100*time.Millisecond ||
		cfg.AttemptBound != 30*time.Second || cfg.IdentityTolerance != 2*time.Second ||
		cfg.AnchoredPollEvery != time.Hour {
		t.Fatalf("DefaultConfig() durations = %+v", cfg)
	}

	if want := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC); !cfg.MinValidUTC.Equal(want) {
		t.Fatalf("MinValidUTC = %s, want %s", cfg.MinValidUTC, want)
	}

	if want := time.Date(2056, time.January, 1, 0, 0, 0, 0, time.UTC); !cfg.MaxValidUTC.Equal(want) {
		t.Fatalf("MaxValidUTC = %s, want %s", cfg.MaxValidUTC, want)
	}
}

func testUTC() time.Time {
	return time.Date(2030, time.May, 17, 12, 30, 0, 0, time.UTC)
}

func testBootID() [16]byte {
	return [16]byte{1, 2, 3, 4}
}

func newTestKeeper(saved *State) *Keeper {
	return New(DefaultConfig(), testBootID(), saved)
}

func savedState(server string, syncStart int64, offset int64) State {
	return State{BootID: testBootID(), OffsetMs: offset, Server: server, SyncStartBootMs: syncStart}
}

func goodEvidence(server string, elapsed int64) NTPStatus {
	return NTPStatus{ElapsedS: elapsed, Server: server, Accurate: true, Synchronized: true}
}

func armClockChange(k *Keeper, lastChangeBootMs int64) {
	k.ObserveClock(Reading{BootMs: 0, WallMs: 0})
	k.ObserveClock(Reading{BootMs: lastChangeBootMs, WallMs: lastChangeBootMs + 101})
}
