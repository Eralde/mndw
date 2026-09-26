package clock

import (
	"context"
	"errors"
)

// ReadEvidence brackets one evidence query with boot-relative coordinate
// reads. A failure leaves the clock unchanged and never anchors.
func ReadEvidence(ctx context.Context, clock BootClock, source EvidenceSource, request EvidenceRequest) (Reading, Reading, Evidence, error) {
	before, err := clock.Read()
	if err != nil {
		return Reading{}, Reading{}, Evidence{}, err
	}

	if source == nil {
		return before, before, Evidence{}, errors.New("telemetry: evidence source is required")
	}

	evidence, err := source.Read(ctx, request)
	if err != nil {
		return before, before, Evidence{}, err
	}

	after, err := clock.Read()
	if err != nil {
		return before, after, Evidence{}, err
	}

	if after.Boot != before.Boot || after.ElapsedMs < before.ElapsedMs {
		return before, after, Evidence{}, errors.New("telemetry: observation bracket is inconsistent")
	}

	return before, after, evidence, nil
}

// staticEvidenceSource returns a fixed observation for tests.
type staticEvidenceSource struct {
	evidence Evidence
	err      error
	calls    int
	requests []EvidenceRequest
}

func (s *staticEvidenceSource) Read(_ context.Context, request EvidenceRequest) (Evidence, error) {
	s.calls++
	s.requests = append(s.requests, request)

	if s.err != nil {
		return Evidence{}, s.err
	}

	return s.evidence, nil
}

// scriptedClock returns readings in order for tests.
type scriptedClock struct {
	readings []Reading
	index    int
	err      error
}

func (c *scriptedClock) Read() (Reading, error) {
	if c.err != nil {
		return Reading{}, c.err
	}

	if c.index >= len(c.readings) {
		return c.readings[len(c.readings)-1], nil
	}

	reading := c.readings[c.index]
	c.index++

	return reading, nil
}
