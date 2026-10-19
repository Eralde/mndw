package telemetry

import (
	"errors"
	"testing"
	"time"

	"mndwd/internal/telemetry/journal"
)

func TestPolicyRejectsLongLossWindow(t *testing.T) {
	p := DefaultPolicy()
	p.MaxUnsynced = 16 * time.Minute

	if err := ValidatePolicy(p); err == nil {
		t.Fatal("accepted power-loss window above fifteen minutes")
	}
}

func TestPolicyRejectsShortLossWindow(t *testing.T) {
	p := DefaultPolicy()
	p.MaxUnsynced = 2*time.Minute + 59*time.Second

	if err := ValidatePolicy(p); err == nil {
		t.Fatal("accepted power-loss window below three minutes")
	}
}

func TestPolicyAcceptsWindowEndpoints(t *testing.T) {
	for _, window := range []time.Duration{3 * time.Minute, 15 * time.Minute} {
		p := DefaultPolicy()
		p.MaxUnsynced = window

		if err := ValidatePolicy(p); err != nil {
			t.Fatalf("window %s rejected: %v", window, err)
		}
	}
}

func TestPolicyDefaultsMatchConstraints(t *testing.T) {
	p := DefaultPolicy()

	if p.AcquireEvery != 3*time.Minute {
		t.Fatalf("acquireEvery=%s", p.AcquireEvery)
	}

	if p.EvidenceEvery != 15*time.Second {
		t.Fatalf("evidenceEvery=%s", p.EvidenceEvery)
	}

	if p.PublishEvery != 15*time.Minute {
		t.Fatalf("publishEvery=%s", p.PublishEvery)
	}

	if p.MaxUnsynced != 3*time.Minute {
		t.Fatalf("maxUnsynced=%s", p.MaxUnsynced)
	}

	if p.JumpThreshold != 5*time.Second {
		t.Fatalf("jumpThreshold=%s", p.JumpThreshold)
	}

	if p.MaxObservationSpan != time.Second {
		t.Fatalf("maxObservationSpan=%s", p.MaxObservationSpan)
	}

	if p.QueueBytes != 64<<10 {
		t.Fatalf("queueBytes=%d", p.QueueBytes)
	}

	if p.Journal != journal.DefaultLimits() {
		t.Fatalf("journal limits=%+v", p.Journal)
	}

	if err := ValidatePolicy(p); err != nil {
		t.Fatalf("defaults rejected: %v", err)
	}
}

func TestPolicyRejectsNonPositiveLimits(t *testing.T) {
	cases := map[string]func(*Policy){
		"acquireEvery":    func(p *Policy) { p.AcquireEvery = 0 },
		"evidenceEvery":   func(p *Policy) { p.EvidenceEvery = -time.Second },
		"publishEvery":    func(p *Policy) { p.PublishEvery = 0 },
		"jumpThreshold":   func(p *Policy) { p.JumpThreshold = 0 },
		"observationSpan": func(p *Policy) { p.MaxObservationSpan = -time.Millisecond },
		"queueBytes":      func(p *Policy) { p.QueueBytes = 0 },
		"journalBytes":    func(p *Policy) { p.Journal.Bytes = 0 },
		"scratchBytes":    func(p *Policy) { p.Journal.ScratchBytes = -1 },
		"segmentBytes":    func(p *Policy) { p.Journal.SegmentBytes = 0 },
		"sessions":        func(p *Policy) { p.Journal.Sessions = 0 },
		"retention":       func(p *Policy) { p.Journal.Retention = 0 },
	}

	for name, mutate := range cases {
		p := DefaultPolicy()

		mutate(&p)

		if err := ValidatePolicy(p); err == nil {
			t.Fatalf("accepted non-positive %s", name)
		}
	}
}

func TestPolicyRejectsSegmentLargerThanScratch(t *testing.T) {
	p := DefaultPolicy()
	p.Journal.SegmentBytes = p.Journal.ScratchBytes + 1

	if err := ValidatePolicy(p); !errors.Is(err, errSegmentExceedsScratch) {
		t.Fatalf("accepted oversized segment: %v", err)
	}
}
