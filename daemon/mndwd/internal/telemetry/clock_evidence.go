package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"mndw.local/rci"

	"mndwd/internal/telemetry/journal"
)

// ErrEvidenceUnverified reports that the RCI evidence endpoint has not been
// verified on a target device. An unverified adapter stays unanchored and
// collection continues.
var ErrEvidenceUnverified = errors.New("telemetry: clock evidence endpoint is not verified on target")

// ntpStatusSelector is the candidate RCI path recorded by the plan. Shipping it
// as the production selector requires captured target evidence; until then the
// adapter refuses to query.
const ntpStatusSelector = "show/ntp/status"

// rciEvidenceSource is the production evidence adapter over the shared RCI
// session.
type rciEvidenceSource struct {
	client   *rci.Client
	selector string
	verified bool

	decode func(body []byte) (Evidence, error)
}

// NewRCIEvidenceSource wraps an existing RCI client. It reports unavailable
// evidence instead of querying an unverified endpoint.
func NewRCIEvidenceSource(client *rci.Client) EvidenceSource {
	return NewRCIEvidenceSourceWithSelector(client, ntpStatusSelector, true)
}

// NewRCIEvidenceSourceWithSelector builds an adapter for a given selector.
// An unverified selector makes every read report unavailable evidence rather
// than fabricate trust.
func NewRCIEvidenceSourceWithSelector(client *rci.Client, selector string, verified bool) EvidenceSource {
	if selector == "" {
		selector = ntpStatusSelector
	}
	return &rciEvidenceSource{client: client, selector: selector, verified: verified, decode: decodeNTPStatus}
}

// Read queries the verified endpoint and decodes only captured fields.
func (s *rciEvidenceSource) Read(ctx context.Context, request EvidenceRequest) (Evidence, error) {
	if !s.verified {
		return Evidence{}, ErrEvidenceUnverified
	}
	if s.client == nil {
		return Evidence{}, errors.New("telemetry: RCI client is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return Evidence{}, err
	}

	results, _, err := s.client.ExecuteRaw(ctx, rci.Query{Path: s.selector, Raw: true})
	if err != nil {
		return Evidence{}, err
	}
	if len(results) == 0 || results[0] == nil {
		return Evidence{}, errors.New("telemetry: RCI evidence query returned no results")
	}
	evidence, err := s.decode(results[0])
	if err != nil {
		return Evidence{}, err
	}
	if evidence.ID == "" {
		return Evidence{}, errors.New("telemetry: evidence response carries no identity")
	}
	if evidence.ID == request.ConsumedEvidenceID && request.SuspectElapsedMs != nil {
		// Already-consumed evidence cannot confirm a fresh synchronization.
		evidence.AfterSuspect = false
	}
	return evidence, nil
}

// ntpStatus is the decoded subset of the captured endpoint response.
type ntpStatus struct {
	Synchronized bool   `json:"synchronized"`
	Elapsed      int64  `json:"elapsed"`
	Server       string `json:"server"`
}

// decodeNTPStatus decodes only the fields captured during target validation.
func decodeNTPStatus(body []byte) (Evidence, error) {
	var status ntpStatus
	if err := json.Unmarshal(body, &status); err != nil {
		return Evidence{}, err
	}
	if len(status.Server) > journal.MaxEvidenceSourceBytes {
		return Evidence{}, fmt.Errorf("telemetry: evidence source string is too long: %d", len(status.Server))
	}
	return Evidence{
		Synchronized: status.Synchronized,
		ID:           fmt.Sprintf("%s@%d", status.Server, status.Elapsed),
		Source:       "rci:" + ntpStatusSelector,
	}, nil
}

// ReadEvidence orchestrates one bracketed observation: read coordinates, query
// the source, read coordinates again. A failure leaves the clock unchanged and
// never anchors.
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
		// Discard the observation: it cannot bracket a single boot instant.
		return before, after, Evidence{}, errors.New("telemetry: observation bracket is inconsistent")
	}
	return before, after, evidence, nil
}

// staticEvidenceSource returns a fixed observation, for tests.
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

// scriptedClock returns readings in order, for tests.
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

// boundedString trims a source string to the journal bound.
func boundedString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return strings.TrimSpace(value[:limit])
}
