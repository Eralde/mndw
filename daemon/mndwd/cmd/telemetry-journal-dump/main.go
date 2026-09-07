// Command telemetry-journal-dump renders retained journal records for
// diagnostics. It is strictly read-only: it never initializes, repairs,
// truncates, or invokes RRDtool.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"mndwd/internal/telemetry/journal"
)

// DegradedError reports a read-only salvage: validated records were emitted but
// coverage may be incomplete.
type DegradedError struct {
	Status journal.RecoveryStatus
}

// Error implements error.
func (e *DegradedError) Error() string {
	return fmt.Sprintf("telemetry-journal-dump: degraded recovery (%s)", e.Status.Mode)
}

// Options bound the dump output and select one session.
type Options struct {
	RRDPath    string
	Session    string
	FileSystem journal.FileSystem
	Locker     journal.Locker
}

type statusLine struct {
	Type    string                  `json:"type"`
	Mode    string                  `json:"mode"`
	Issues  []journal.RecoveryIssue `json:"issues,omitempty"`
	Session string                  `json:"session,omitempty"`
}

type recordLine struct {
	Type           string     `json:"type"`
	Durability     string     `json:"durability"`
	Sequence       string     `json:"sequence"`
	Kind           string     `json:"kind"`
	Boot           string     `json:"boot,omitempty"`
	ClockSegment   uint64     `json:"clockSegment,omitempty"`
	Series         uint16     `json:"series,omitempty"`
	ElapsedMs      *int64     `json:"elapsedMs,omitempty"`
	UTCMs          *int64     `json:"utcMs,omitempty"`
	UncertaintyMs  *int64     `json:"uncertaintyMs,omitempty"`
	EvidenceID     string     `json:"evidenceId,omitempty"`
	EvidenceSource string     `json:"evidenceSource,omitempty"`
	State          *uint8     `json:"state,omitempty"`
	Values         []*float64 `json:"values,omitempty"`
	Count          *uint64    `json:"count,omitempty"`
}

// main runs the dump and exits nonzero for degraded or unavailable recovery.
func main() {
	options := Options{FileSystem: journal.OSFileSystem{}, Locker: journal.OSLocker{}}
	if err := run(os.Args[1:], os.Stdout, options); err != nil {
		var degraded *DegradedError
		if errors.As(err, &degraded) {
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

// run dumps validated records for the requested storage.
func run(args []string, out io.Writer, options Options) error {
	flags := flag.NewFlagSet("telemetry-journal-dump", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	rrdPath := flags.String("rrd-dir", "", "parent telemetry directory containing staging/")
	session := flags.String("session", "", "restrict output to one session id or boot id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *rrdPath != "" {
		options.RRDPath = *rrdPath
	}
	if *session != "" {
		options.Session = *session
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("telemetry-journal-dump: unexpected argument %q", flags.Arg(0))
	}

	paths, err := journal.PathsFromRRDDir(options.RRDPath)
	if err != nil {
		return err
	}
	fs := options.FileSystem
	if fs == nil {
		fs = journal.OSFileSystem{}
	}
	locker := options.Locker
	if locker == nil {
		locker = journal.OSLocker{}
	}

	result, err := journal.OpenReadOnly(context.Background(), paths, fs, locker)
	if err != nil {
		return err
	}
	if result.Reader == nil {
		_ = writeJSON(out, statusLine{Type: "status", Mode: string(journal.StatusUnavailable), Issues: result.Status.Issues})
		return &DegradedError{Status: result.Status}
	}
	defer func() { _ = result.Reader.Close() }()

	if err := writeJSON(out, statusLine{
		Type:    "status",
		Mode:    string(result.Status.Mode),
		Issues:  result.Status.Issues,
		Session: options.Session,
	}); err != nil {
		return err
	}

	seen := map[uint64]string{}
	conflicts := map[uint64]bool{}
	var writeErr error
	err = result.Reader.Scan(context.Background(), func(record journal.Record) error {
		if writeErr != nil {
			return writeErr
		}
		if !matchesSession(record, options.Session) {
			return nil
		}
		digest := recordDigest(record)
		if previous, ok := seen[record.Seq]; ok {
			if previous != digest {
				// Conflicting copies are omitted rather than guessed between.
				conflicts[record.Seq] = true
			}
			return nil
		}
		seen[record.Seq] = digest
		if conflicts[record.Seq] {
			return nil
		}
		line := renderRecord(record)
		if err := writeJSON(out, line); err != nil {
			writeErr = err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if writeErr != nil {
		return writeErr
	}

	if result.Status.Mode != journal.StatusReady || len(result.Status.Issues) > 0 {
		return &DegradedError{Status: result.Status}
	}
	return nil
}

// recordDigest identifies identical frame copies so duplicates and conflicts
// can be reported without choosing between them.
func recordDigest(record journal.Record) string {
	sum := sha256.Sum256(append([]byte{byte(record.Kind)}, record.Payload...))
	return hex.EncodeToString(sum[:])
}

// matchesSession filters records by session or boot identifier.
func matchesSession(record journal.Record, session string) bool {
	if session == "" {
		return true
	}
	boot := recordBoot(record)
	if boot == "" {
		return false
	}
	return session == boot || session == "s1-"+boot || strings.TrimPrefix(session, "s1-") == boot
}

func recordBoot(record journal.Record) string {
	switch record.Kind {
	case journal.KindSample:
		if sample, err := journal.DecodeSample(record); err == nil {
			return sample.Boot.String()
		}
	case journal.KindAnchor:
		if anchor, err := journal.DecodeAnchor(record); err == nil {
			return anchor.Boot.String()
		}
	case journal.KindClockTransition:
		if transition, err := journal.DecodeClockTransition(record); err == nil {
			return transition.Boot.String()
		}
	case journal.KindBootStart:
		if bootStart, err := journal.DecodeBootStart(record); err == nil {
			return bootStart.Boot.String()
		}
	}
	return ""
}

func renderRecord(record journal.Record) recordLine {
	line := recordLine{
		Type:       "record",
		Durability: "unproven",
		Sequence:   fmt.Sprintf("%d", record.Seq),
		Kind:       kindName(record.Kind),
	}
	switch record.Kind {
	case journal.KindSample:
		if sample, err := journal.DecodeSample(record); err == nil {
			line.Boot = sample.Boot.String()
			line.ClockSegment = sample.ClockSegment
			line.Series = sample.Series
			elapsed := sample.ElapsedMs
			line.ElapsedMs = &elapsed
			for _, value := range sample.Values {
				if !value.Known {
					line.Values = append(line.Values, nil)
					continue
				}
				known := value.V
				line.Values = append(line.Values, &known)
			}
		}
	case journal.KindAnchor:
		if anchor, err := journal.DecodeAnchor(record); err == nil {
			line.Boot = anchor.Boot.String()
			line.ClockSegment = anchor.ClockSegment
			line.ElapsedMs = &anchor.ElapsedMs
			line.UTCMs = &anchor.UTCMs
			line.UncertaintyMs = &anchor.UncertaintyMs
			line.EvidenceID = anchor.EvidenceID
			line.EvidenceSource = anchor.EvidenceSource
		}
	case journal.KindClockTransition:
		if transition, err := journal.DecodeClockTransition(record); err == nil {
			line.Boot = transition.Boot.String()
			line.ClockSegment = transition.ClockSegment
			state := uint8(transition.State)
			line.State = &state
			line.EvidenceID = transition.ConsumedEvidenceID
		}
	case journal.KindBootStart:
		if bootStart, err := journal.DecodeBootStart(record); err == nil {
			line.Boot = bootStart.Boot.String()
			elapsed := bootStart.FirstAcquireElapsedMs
			line.ElapsedMs = &elapsed
		}
	case journal.KindLoss:
		if loss, err := journal.DecodeLoss(record); err == nil {
			count := loss.Count
			line.Count = &count
		}
	}
	return line
}

func kindName(kind journal.Kind) string {
	switch kind {
	case journal.KindSample:
		return "sample"
	case journal.KindAnchor:
		return "anchor"
	case journal.KindClockTransition:
		return "clock-transition"
	case journal.KindPublication:
		return "publication"
	case journal.KindLoss:
		return "loss"
	case journal.KindBootStart:
		return "boot-start"
	default:
		return "unknown"
	}
}

func writeJSON(out io.Writer, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = out.Write(append(encoded, '\n'))
	return err
}
