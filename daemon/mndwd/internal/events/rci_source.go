package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	rci "mndw.local/rci"
)

type RawQueryClient interface {
	ExecuteRaw(context.Context, ...rci.Query) ([]json.RawMessage, []byte, error)
}

type RCILogSource struct {
	client RawQueryClient
}

func NewRCILogSource(client RawQueryClient) *RCILogSource {
	return &RCILogSource{client: client}
}

func (s *RCILogSource) ShowLog(ctx context.Context) (map[string]RawLogRecord, error) {
	values, _, err := s.client.ExecuteRaw(ctx, rci.Q("show.log"))
	if err != nil {
		return nil, err
	}

	if len(values) == 0 {
		return nil, fmt.Errorf("show.log returned no response")
	}

	var response struct {
		Log  map[string]RawLogRecord `json:"log"`
		Show struct {
			Log map[string]RawLogRecord `json:"log"`
		} `json:"show"`
	}

	if err := json.Unmarshal(values[0], &response); err != nil {
		return nil, fmt.Errorf("decode show.log response: %w", err)
	}

	logs := response.Log

	if logs == nil {
		logs = response.Show.Log
	}

	if logs == nil {
		// rci.Client returns the selected path for ordinary queries. Some
		// controllers expose records directly at show.log, while others wrap
		// them in a {"log": ...} object; accept both forms.
		if err := json.Unmarshal(values[0], &logs); err != nil {
			return nil, fmt.Errorf("decode show.log records: %w", err)
		}
	}

	if logs == nil {
		return map[string]RawLogRecord{}, nil
	}

	return logs, nil
}

func QueryDeviceTimezone(ctx context.Context, client RawQueryClient) *time.Location {
	if client == nil {
		return time.UTC
	}

	values, _, err := client.ExecuteRaw(ctx, rci.Q("show.clock.date"))
	if err != nil || len(values) == 0 {
		return time.UTC
	}

	var response struct {
		TZ []struct {
			Locality string `json:"locality"`
		} `json:"tz"`
		Show struct {
			Clock struct {
				Date struct {
					TZ []struct {
						Locality string `json:"locality"`
					} `json:"tz"`
				} `json:"date"`
			} `json:"clock"`
		} `json:"show"`
	}

	if err := json.Unmarshal(values[0], &response); err != nil {
		return time.UTC
	}

	zone := ""

	if len(response.TZ) > 0 {
		zone = response.TZ[0].Locality
	}

	if zone == "" && len(response.Show.Clock.Date.TZ) > 0 {
		zone = response.Show.Clock.Date.TZ[0].Locality
	}

	if zone == "" {
		return time.UTC
	}

	location, err := time.LoadLocation(zone)
	if err != nil {
		return time.UTC
	}

	return location
}
