package telemetry

import (
	"errors"
	"time"
)

// nextDeadline returns the first scheduled deadline at or after `now` on a
// period anchored at `origin`. Missed slots stay gaps: the schedule never
// resets to process start time when a boot record already exists.
func nextDeadline(origin, period, now int64) int64 {
	if period <= 0 {
		return now
	}
	if now <= origin {
		return origin
	}
	elapsed, ok := CheckedSubInt64(now, origin)
	if !ok {
		return now
	}
	slots := elapsed/period + 1
	if elapsed%period == 0 {
		slots = elapsed / period
	}
	delta, ok := checkedMulInt64(slots, period)
	if !ok {
		return now
	}
	deadline, ok := CheckedAddInt64(origin, delta)
	if !ok {
		return now
	}
	if deadline < now {
		// Choose a strictly future deadline when this slot was already used.
		next, ok := CheckedAddInt64(deadline, period)
		if !ok {
			return now
		}
		return next
	}
	return deadline
}

// nextDeadlineAfter returns the next deadline strictly after `now`, so a
// scheduler that just ran a slot sleeps instead of spinning on an elapsed
// deadline.
func nextDeadlineAfter(origin, period, now int64) int64 {
	deadline := nextDeadline(origin, period, now)
	if deadline <= now {
		if next, ok := CheckedAddInt64(deadline, period); ok {
			return next
		}
	}
	return deadline
}

// SyncDeadline returns the elapsed deadline by which the oldest unsynced
// acquisition must be synchronized. It is independent of future successful
// polls.
func SyncDeadline(firstUnsyncedMs int64, window time.Duration) int64 {
	if window <= 0 {
		return firstUnsyncedMs
	}
	deadline, ok := CheckedAddInt64(firstUnsyncedMs, window.Milliseconds())
	if !ok {
		return firstUnsyncedMs
	}
	return deadline
}

func checkedMulInt64(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	if a > 0 && b > 0 && a > maxInt64/b {
		return 0, false
	}
	if a < 0 && b < 0 && a < maxInt64/b {
		return 0, false
	}
	if (a > 0 && b < 0 && b < minInt64/a) || (a < 0 && b > 0 && a < minInt64/b) {
		return 0, false
	}
	result := a * b
	if (a == -1 && b == minInt64) || (b == -1 && a == minInt64) {
		return 0, false
	}
	return result, true
}

// ErrScheduleOverflow reports a deadline computation that cannot be represented.
var ErrScheduleOverflow = errors.New("telemetry: schedule overflow")
