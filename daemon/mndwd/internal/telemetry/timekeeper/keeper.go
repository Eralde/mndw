package timekeeper

import (
	"time"
)

// Reading pairs the monotonic boot clock with the wall clock in milliseconds.
type Reading struct {
	BootMs int64
	WallMs int64
}

// Config contains timekeeper thresholds and validity bounds.
type Config struct {
	ClockCheckEvery, ClockChangeThreshold time.Duration
	BracketMaxBoot, BracketMaxSkew        time.Duration
	AttemptBound, IdentityTolerance       time.Duration
	AnchoredPollEvery                     time.Duration
	MinValidUTC, MaxValidUTC              time.Time
}

// DefaultConfig returns the telemetry timekeeping constants from the spec.
func DefaultConfig() Config {
	minValidUTC := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

	return Config{
		ClockCheckEvery:      10 * time.Second,
		ClockChangeThreshold: 100 * time.Millisecond,
		BracketMaxBoot:       time.Second,
		BracketMaxSkew:       100 * time.Millisecond,
		AttemptBound:         30 * time.Second,
		IdentityTolerance:    2 * time.Second,
		AnchoredPollEvery:    time.Hour,
		MinValidUTC:          minValidUTC,
		MaxValidUTC:          minValidUTC.AddDate(30, 0, 0),
	}
}

// Decision is the result of evaluating one decoded NTP status.
type Decision int

const (
	// Ignore means the status is not evidence, not new, or acceptance is blocked.
	Ignore Decision = iota
	// Retry means the clock-read bracket failed and another poll is due at a clock check.
	Retry
	// Reject means freshness or a validity filter failed.
	Reject
	// Accept means the evidence can become the durable clock state.
	Accept
)

// Outcome contains a timekeeper decision and candidate accepted state.
type Outcome struct {
	Decision Decision
	State    State
	Reason   string
}

// Trigger identifies why the caller is considering an NTP poll.
type Trigger int

const (
	// TriggerTick is a collection tick.
	TriggerTick Trigger = iota
	// TriggerClockCheck is a periodic clock check.
	TriggerClockCheck
)

// Keeper implements pure clock, poll-schedule, and NTP evidence rules.
type Keeper struct {
	cfg              Config
	bootID           [16]byte
	state            State
	anchored         bool
	blocked          bool
	clockObserved    bool
	lastClockDeltaMs int64
	clockChangeArmed bool
	lastChangeBootMs *int64
	lastPollBootMs   int64
	retryOutstanding bool
}

// New creates a keeper and restores saved state only when it belongs to bootID.
func New(cfg Config, bootID [16]byte, saved *State) *Keeper {
	k := &Keeper{cfg: cfg, bootID: bootID}

	if saved != nil && saved.BootID == bootID {
		k.state = *saved
		k.anchored = true
	}

	return k
}

// Anchored returns the committed state when this boot has accepted evidence.
func (k *Keeper) Anchored() (State, bool) {
	return k.state, k.anchored
}

// ObserveClock records a baseline or arms polling after a wall-minus-boot change.
func (k *Keeper) ObserveClock(r Reading) {
	delta := r.WallMs - r.BootMs

	if k.clockObserved && absDifferenceGreater(delta, k.lastClockDeltaMs, k.cfg.ClockChangeThreshold.Milliseconds()) {
		lastChange := r.BootMs
		k.lastChangeBootMs = &lastChange
		k.clockChangeArmed = true
	}

	k.lastClockDeltaMs = delta
	k.clockObserved = true
}

// WantPoll reports whether the given tick or clock check should poll NTP.
func (k *Keeper) WantPoll(r Reading, trigger Trigger) bool {
	if k.clockChangeArmed {
		return true
	}

	if k.retryOutstanding && trigger == TriggerClockCheck {
		return true
	}

	if !k.anchored {
		return trigger == TriggerTick
	}

	return r.BootMs >= k.lastPollBootMs+k.cfg.AnchoredPollEvery.Milliseconds()
}

// Evaluate applies evidence, freshness, bracket, and UTC validity rules.
func (k *Keeper) Evaluate(before, after Reading, st NTPStatus) Outcome {
	k.lastPollBootMs = after.BootMs
	k.clockChangeArmed = false
	k.retryOutstanding = false

	if !st.IsEvidence() {
		return Outcome{Decision: Ignore, Reason: "not NTP evidence"}
	}

	if k.blocked {
		return Outcome{Decision: Ignore, Reason: "acceptance is blocked"}
	}

	midBoot := (before.BootMs + after.BootMs) / 2
	midWall := (before.WallMs + after.WallMs) / 2
	syncStartBootMs := midBoot - st.ElapsedS*1000

	if k.anchored && st.Server == k.state.Server && !absDifferenceGreater(syncStartBootMs, k.state.SyncStartBootMs, k.cfg.IdentityTolerance.Milliseconds()) {
		return Outcome{Decision: Ignore, Reason: "NTP evidence identity is unchanged"}
	}

	deltaBoot := after.BootMs - before.BootMs
	deltaWall := after.WallMs - before.WallMs

	if deltaBoot < 0 || deltaBoot > k.cfg.BracketMaxBoot.Milliseconds() ||
		absDifferenceGreater(deltaWall, deltaBoot, k.cfg.BracketMaxSkew.Milliseconds()) {
		k.retryOutstanding = true

		return Outcome{Decision: Retry, Reason: "clock-read bracket exceeded limits"}
	}

	if k.lastChangeBootMs != nil {
		latestFreshChange := syncStartBootMs + k.cfg.AttemptBound.Milliseconds() + k.cfg.ClockCheckEvery.Milliseconds()

		if *k.lastChangeBootMs > latestFreshChange {
			return Outcome{Decision: Reject, Reason: "NTP evidence predates the last clock change"}
		}
	}

	if midWall < k.cfg.MinValidUTC.UnixMilli() || midWall > k.cfg.MaxValidUTC.UnixMilli() {
		return Outcome{Decision: Reject, Reason: "NTP time is outside the valid UTC range"}
	}

	return Outcome{
		Decision: Accept,
		State: State{
			BootID:          k.bootID,
			OffsetMs:        midWall - midBoot,
			Server:          st.Server,
			SyncStartBootMs: syncStartBootMs,
		},
		Reason: "accepted NTP evidence",
	}
}

// PollFailed records a completed source-error poll and retains armed retries.
func (k *Keeper) PollFailed(r Reading) {
	k.lastPollBootMs = r.BootMs
}

// Commit stores a candidate state after its durable write succeeds.
func (k *Keeper) Commit(s State) {
	if s.BootID != k.bootID {
		return
	}

	k.state = s
	k.anchored = true
}

// SetBlocked controls whether otherwise valid evidence can be accepted.
func (k *Keeper) SetBlocked(blocked bool) {
	k.blocked = blocked
}

func absDifferenceGreater(a, b, limit int64) bool {
	if a >= b {
		return uint64(a)-uint64(b) > uint64(limit)
	}

	return uint64(b)-uint64(a) > uint64(limit)
}
