// Package journal implements the authoritative retained telemetry journal.
//
// Records are appended to boot-scoped segment files with a versioned,
// checksummed framing. The journal is independent of daemon telemetry types so
// that storage code never imports the daemon package.
package journal

import (
	"context"
	"errors"
	"time"
)

// ErrUnsupported reports a journal artifact that this build cannot read, such
// as a newer file or record version. Unsupported artifacts are left untouched.
var ErrUnsupported = errors.New("journal: unsupported version")

// ErrInvalidPaths reports storage paths that are not an absolute, non-root RRD
// directory and its staging child.
var ErrInvalidPaths = errors.New("journal: invalid storage paths")

// BootID is the Linux boot identifier read from
// /proc/sys/kernel/random/boot_id. It identifies one device boot across daemon
// restarts.
type BootID [16]byte

// String renders the identifier as 32 lowercase hexadecimal digits.
func (id BootID) String() string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, len(id)*2)
	for _, b := range id {
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return string(out)
}

// IsZero reports whether the identifier is the all-zero value, which never
// identifies a real boot.
func (id BootID) IsZero() bool {
	return id == BootID{}
}

// Kind identifies a record's kindData layout.
type Kind uint16

const (
	KindSample          Kind = 1
	KindAnchor          Kind = 2
	KindClockTransition Kind = 3
	KindPublication     Kind = 4
	KindLoss            Kind = 5
	KindBootStart       Kind = 6
)

// TransitionState is the clock state recorded by a clock-transition record.
type TransitionState uint8

const (
	StateUnanchored TransitionState = 1
	StateAnchored   TransitionState = 2
	StateSuspect    TransitionState = 3
)

// LossReason explains why records were dropped.
type LossReason uint8

const (
	LossAge           LossReason = 1
	LossBudget        LossReason = 2
	LossSessionLimit  LossReason = 3
	LossCorruption    LossReason = 4
	LossQueueOverflow LossReason = 5
)

// CoverageReason explains why a coverage range is incomplete.
type CoverageReason string

const (
	ReasonMissing    CoverageReason = "missing"
	ReasonCorrupt    CoverageReason = "corrupt"
	ReasonUncertain  CoverageReason = "uncertain-time"
	ReasonTruncated  CoverageReason = "truncated"
	ReasonUnanchored CoverageReason = "unanchored"
)

// LockMode selects shared or exclusive storage ownership.
type LockMode uint8

const (
	// LockShared permits concurrent readers and blocks a writable open.
	LockShared LockMode = 1
	// LockExclusive grants a single writer ownership of the journal.
	LockExclusive LockMode = 2
)

// LockHandle is a held storage lock.
type LockHandle interface {
	Close() error
}

// Locker is the only storage-ownership boundary. Production uses `flock`;
// tests inject a deterministic fake.
type Locker interface {
	Acquire(context.Context, string, LockMode) (LockHandle, error)
}

// StatusMode is the outcome of opening journal storage.
type StatusMode string

const (
	// StatusReady permits append, publication, and reads.
	StatusReady StatusMode = "ready"
	// StatusReadOnly permits bounded validated salvage and no mutation.
	StatusReadOnly StatusMode = "read-only"
	// StatusUnavailable has no usable reader or writer.
	StatusUnavailable StatusMode = "unavailable"
)

// RecoveryIssue describes one recoverable problem with a sequence range when
// the affected range is known.
type RecoveryIssue struct {
	Code          string
	FirstSequence *uint64
	LastSequence  *uint64
}

// RecoveryStatus is an explicit storage-open outcome.
type RecoveryStatus struct {
	Mode   StatusMode
	Issues []RecoveryIssue
}

// OpenResult is a writable open outcome. A ready status requires both handles;
// read-only has a reader and no writer; unavailable has neither.
type OpenResult struct {
	Writer *Storage
	Reader *Reader
	Status RecoveryStatus
}

// ReadResult is a read-only open outcome.
type ReadResult struct {
	Reader *Reader
	Status RecoveryStatus
}

// StorageProvider grants leases on the latest storage snapshot and supports
// reattachment without resetting retained files.
type StorageProvider interface {
	CurrentStatus() RecoveryStatus
	Acquire(context.Context) (StorageLease, error)
	Reopen(context.Context) (OpenResult, error)
	Close(context.Context) error
}

// StorageLease holds one reference to a provider generation for the duration
// of a single scan, append, or publication operation.
type StorageLease struct {
	Result     OpenResult
	provider   *provider
	generation uint64
}

// Value is one measurement with an explicit known/unknown marker.
type Value struct {
	Known bool
	V     float64
}

// Sample is one acquisition record for one series.
type Sample struct {
	Seq          uint64
	Boot         BootID
	ClockSegment uint64
	Series       uint16 // 1: load(cpu,ram), 2: temperature(milliCelsius)
	ElapsedMs    int64
	Values       []Value
}

// Anchor maps one boot-relative elapsed instant to trustworthy UTC time.
type Anchor struct {
	Seq            uint64
	Boot           BootID
	ClockSegment   uint64
	ElapsedMs      int64
	UTCMs          int64
	UncertaintyMs  int64
	EvidenceID     string
	EvidenceSource string
}

// Frontier is the publication progress of one series at a boundary.
type Frontier struct {
	Series uint16
	SlotMs int64
}

// Publication freezes canonical slot selection for one publication cycle.
type Publication struct {
	Seq             uint64
	SampleThrough   uint64
	AnchorThrough   uint64
	CutoffElapsedMs int64
	Frontiers       []Frontier
}

// Record is one journal record. Payload holds kindData only; Seq belongs to the
// common record body and is restored by the decoder.
type Record struct {
	Kind    Kind
	Seq     uint64
	Payload []byte
}

// BootStart records the acquisition origin of one boot. Its allocated sequence
// is the boot order copied into segment headers.
type BootStart struct {
	Seq                   uint64
	Boot                  BootID
	FirstAcquireElapsedMs int64
}

// ClockTransition records a clock-state change inside one boot.
type ClockTransition struct {
	Seq                uint64
	Boot               BootID
	ClockSegment       uint64
	State              TransitionState
	SuspectElapsedMs   *int64
	ConsumedEvidenceID string
}

// SequenceRange is an inclusive range of allocated sequences.
type SequenceRange struct {
	First uint64
	Last  uint64
}

// Loss counts dropped samples and optionally names their allocated sequences.
type Loss struct {
	Seq       uint64
	Reason    LossReason
	Count     uint64
	Allocated *SequenceRange
}

// AppendResult reports the outcome of one append attempt.
type AppendResult struct {
	Accepted      int
	FirstSequence uint64
	LastSequence  uint64
	NeedsRepair   bool
}

// Limits bounds journal storage. Bytes is the steady-state budget,
// ScratchBytes the additional compaction allowance, and SegmentBytes the
// per-segment cap.
type Limits struct {
	Bytes        int64
	ScratchBytes int64
	SegmentBytes int64
	Sessions     int
	Retention    time.Duration
}

// Total returns the steady-state budget plus the compaction allowance.
func (l Limits) Total() int64 {
	return l.Bytes + l.ScratchBytes
}

// Coverage describes the reconstructable extent of one series.
type Coverage struct {
	Series       uint16
	StartMs      *int64
	EndMs        *int64
	EdgeComplete bool
	Complete     bool
	Reasons      []CoverageReason
}

// DefaultLimits is the single source of journal defaults. Policy uses it rather
// than declaring a second set of numbers.
func DefaultLimits() Limits {
	return Limits{
		Bytes:        8 << 20,
		ScratchBytes: 1 << 20,
		SegmentBytes: 512 << 10,
		Sessions:     64,
		Retention:    30 * 24 * time.Hour,
	}
}
