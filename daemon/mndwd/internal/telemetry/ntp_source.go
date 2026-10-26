package telemetry

import (
	"context"
	"errors"
	"fmt"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/telemetry/system"
)

const ntpRequestTimeout = 5 * time.Second

// NewRCINTPSource retrieves raw show.ntp.status evidence with a bounded call.
func NewRCINTPSource(client *rci.Client) system.NTPSource {
	return func(ctx context.Context) ([]byte, error) {
		if client == nil {
			return nil, errors.New("telemetry: RCI client is unavailable")
		}

		requestCtx, cancel := context.WithTimeout(ctx, ntpRequestTimeout)

		defer cancel()

		values, _, err := client.ExecuteRaw(requestCtx, rci.Query{Path: "show.ntp.status"})
		if err != nil {
			return nil, fmt.Errorf("telemetry: read show.ntp.status: %w", err)
		}

		if len(values) == 0 || values[0] == nil {
			return nil, errors.New("telemetry: show.ntp.status returned no value")
		}

		return append([]byte(nil), values[0]...), nil
	}
}
