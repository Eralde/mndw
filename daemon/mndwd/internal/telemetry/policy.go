package telemetry

import (
	"errors"
	"fmt"
	"time"

	"mndwd/internal/telemetry/journal"
)

const (
	// minSyncWindow and maxSyncWindow bound the configured maximum duration
	// records may stay unsynced. A longer window trades power-loss protection
	// for fewer sync operations.
	minSyncWindow = 3 * time.Minute
	maxSyncWindow = 15 * time.Minute
)

var errSegmentExceedsScratch = errors.New("telemetry: journal segment size exceeds scratch allowance")

// Policy holds every injectable timing and storage bound for acquisition,
// evidence polling, publication, and journal retention.
type Policy struct {
	AcquireEvery       time.Duration
	EvidenceEvery      time.Duration
	PublishEvery       time.Duration
	MaxUnsynced        time.Duration
	JumpThreshold      time.Duration
	MaxObservationSpan time.Duration
	QueueBytes         int
	Journal            journal.Limits
}

// DefaultPolicy returns the shipped defaults: three-minute acquisition,
// fifteen-second clock-evidence polling, fifteen-minute publication, an
// immediate three-minute durability window, and the journal defaults.
func DefaultPolicy() Policy {
	return Policy{
		AcquireEvery:       3 * time.Minute,
		EvidenceEvery:      15 * time.Second,
		PublishEvery:       15 * time.Minute,
		MaxUnsynced:        minSyncWindow,
		JumpThreshold:      5 * time.Second,
		MaxObservationSpan: time.Second,
		QueueBytes:         64 << 10,
		Journal:            journal.DefaultLimits(),
	}
}

// ValidatePolicy rejects a policy that cannot honor the documented durability,
// observation, or storage bounds.
func ValidatePolicy(p Policy) error {
	if p.AcquireEvery <= 0 {
		return errors.New("telemetry: acquisition interval must be positive")
	}
	if p.EvidenceEvery <= 0 {
		return errors.New("telemetry: clock evidence interval must be positive")
	}
	if p.PublishEvery <= 0 {
		return errors.New("telemetry: publication interval must be positive")
	}
	if p.MaxUnsynced < minSyncWindow || p.MaxUnsynced > maxSyncWindow {
		return fmt.Errorf("telemetry: maximum unsynced duration must be between %s and %s", minSyncWindow, maxSyncWindow)
	}
	if p.JumpThreshold <= 0 {
		return errors.New("telemetry: clock jump threshold must be positive")
	}
	if p.MaxObservationSpan <= 0 {
		return errors.New("telemetry: maximum observation span must be positive")
	}
	if p.QueueBytes <= 0 {
		return errors.New("telemetry: acquisition queue budget must be positive")
	}
	if p.Journal.Bytes <= 0 {
		return errors.New("telemetry: journal budget must be positive")
	}
	if p.Journal.ScratchBytes <= 0 {
		return errors.New("telemetry: journal scratch allowance must be positive")
	}
	if p.Journal.SegmentBytes <= 0 {
		return errors.New("telemetry: journal segment size must be positive")
	}
	if p.Journal.SegmentBytes > p.Journal.ScratchBytes {
		return errSegmentExceedsScratch
	}
	if p.Journal.Sessions <= 0 {
		return errors.New("telemetry: retained session limit must be positive")
	}
	if p.Journal.Retention <= 0 {
		return errors.New("telemetry: journal retention must be positive")
	}
	return nil
}
