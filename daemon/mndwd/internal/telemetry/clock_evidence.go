package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"mndw.local/rci"
	"mndwd/internal/telemetry/clock"

	"mndwd/internal/telemetry/journal"
)

// ErrEvidenceUnverified reports that the RCI evidence endpoint has not been
// verified on a target device. An unverified adapter stays unanchored and
// collection continues.
var ErrEvidenceUnverified = errors.New("telemetry: clock evidence endpoint is not verified on target")

// ntpStatusSelector is the candidate RCI path recorded by the plan. Shipping it
// as the production selector requires captured target evidence; until then the
// adapter refuses to query.
const ntpStatusSelector = "show.ntp.status"

// rciEvidenceSource is the production evidence adapter over the shared RCI
// session.
type rciEvidenceSource struct {
	client   *rci.Client
	selector string
	verified bool

	decode func(body []byte) (clock.Evidence, error)
}

// NewRCIEvidenceSource wraps an existing RCI client. It reports unavailable
// evidence instead of querying an unverified endpoint.
func NewRCIEvidenceSource(client *rci.Client) clock.EvidenceSource {
	return NewRCIEvidenceSourceWithSelector(client, ntpStatusSelector, true)
}

// NewRCIEvidenceSourceWithSelector builds an adapter for a given selector.
// An unverified selector makes every read report unavailable evidence rather
// than fabricate trust.
func NewRCIEvidenceSourceWithSelector(client *rci.Client, selector string, verified bool) clock.EvidenceSource {
	if selector == "" {
		selector = ntpStatusSelector
	}

	return &rciEvidenceSource{client: client, selector: selector, verified: verified, decode: decodeNTPStatus}
}

// Read queries the verified endpoint and decodes only captured fields.
func (s *rciEvidenceSource) Read(ctx context.Context, request clock.EvidenceRequest) (clock.Evidence, error) {
	if !s.verified {
		return clock.Evidence{}, ErrEvidenceUnverified
	}

	if s.client == nil {
		return clock.Evidence{}, errors.New("telemetry: RCI client is unavailable")
	}

	if err := ctx.Err(); err != nil {
		return clock.Evidence{}, err
	}

	results, err := s.client.ExecuteMany(ctx, rci.Query{Path: s.selector})
	if err != nil {
		return clock.Evidence{}, err
	}

	if len(results) == 0 || results[0] == nil {
		return clock.Evidence{}, errors.New("telemetry: RCI evidence query returned no results")
	}

	evidence, err := s.decode(results[0])
	if err != nil {
		return clock.Evidence{}, err
	}

	if evidence.ID == "" {
		return clock.Evidence{}, errors.New("telemetry: evidence response carries no identity")
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
func decodeNTPStatus(body []byte) (clock.Evidence, error) {
	var status ntpStatus

	if err := json.Unmarshal(body, &status); err != nil {
		return clock.Evidence{}, err
	}

	if len(status.Server) > journal.MaxEvidenceSourceBytes {
		return clock.Evidence{}, fmt.Errorf("telemetry: evidence source string is too long: %d", len(status.Server))
	}

	return clock.Evidence{
		Synchronized: status.Synchronized,
		ID:           fmt.Sprintf("%s@%d", status.Server, status.Elapsed),
		Source:       "rci:" + ntpStatusSelector,
	}, nil
}
