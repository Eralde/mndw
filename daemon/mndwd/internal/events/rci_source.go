package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/proxy"
)

type DoFunc func(context.Context, proxy.Request) (proxy.Response, error)

type RCILogProcess struct{ do DoFunc }

var ErrLogProcessGone = errors.New("device log process gone")

func NewRCILogProcess(do DoFunc) *RCILogProcess {
	return &RCILogProcess{do: do}
}

func (p *RCILogProcess) Start(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.records(ctx, http.MethodPost, []byte(fmt.Sprintf(`{"max-lines":%d}`, LogStartMaxLines)))
}

func (p *RCILogProcess) Next(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.records(ctx, http.MethodGet, nil)
}

func (p *RCILogProcess) Tail(ctx context.Context) (map[string]RawLogRecord, error) {
	return p.records(ctx, http.MethodPost, []byte(fmt.Sprintf(`{"once":true,"max-lines":%d}`, LogTailMaxLines)))
}

func (p *RCILogProcess) Stop(ctx context.Context) error {
	if p.do == nil {
		return errors.New("device log process request unavailable")
	}

	response, err := p.do(ctx, proxy.Request{
		Target:     "controller",
		Method:     http.MethodDelete,
		Path:       "rci/show/log",
		AllowWrite: true,
	})
	if err != nil {
		return err
	}

	if response.Status == http.StatusNotFound {
		return ErrLogProcessGone
	}

	if response.Status < http.StatusOK || response.Status >= http.StatusMultipleChoices {
		return fmt.Errorf("device log request failed with status %d", response.Status)
	}

	return nil
}

func (p *RCILogProcess) records(ctx context.Context, method string, body []byte) (map[string]RawLogRecord, error) {
	if p.do == nil {
		return nil, errors.New("device log process request unavailable")
	}

	response, err := p.do(ctx, proxy.Request{
		Target: "controller",
		Method: method,
		Path:   "rci/show/log",
		Body:   body,
	})
	if err != nil {
		return nil, err
	}

	if response.Status == http.StatusNotFound {
		return nil, ErrLogProcessGone
	}

	if response.Status < http.StatusOK || response.Status >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("device log request failed with status %d", response.Status)
	}

	if len(response.Body) == 0 {
		return map[string]RawLogRecord{}, nil
	}

	records, err := decodeLogRecords(response.Body)
	if err != nil {
		return nil, fmt.Errorf("decode device log response: %w", err)
	}

	return records, nil
}

func decodeLogRecords(body []byte) (map[string]RawLogRecord, error) {
	var root map[string]json.RawMessage

	if err := json.Unmarshal(body, &root); err != nil {
		return nil, err
	}

	if root == nil {
		return map[string]RawLogRecord{}, nil
	}

	if raw, ok := root["log"]; ok {
		return decodeRecordMap(raw)
	}

	if raw, ok := root["show"]; ok {
		var show struct {
			Log json.RawMessage `json:"log"`
		}

		if err := json.Unmarshal(raw, &show); err != nil {
			return nil, err
		}

		if len(show.Log) == 0 || string(show.Log) == "null" {
			return map[string]RawLogRecord{}, nil
		}

		return decodeRecordMap(show.Log)
	}

	return map[string]RawLogRecord{}, nil
}

func decodeRecordMap(raw json.RawMessage) (map[string]RawLogRecord, error) {
	var records map[string]RawLogRecord

	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}

	if records == nil {
		return map[string]RawLogRecord{}, nil
	}

	return records, nil
}

type RawQueryClient interface {
	ExecuteRaw(context.Context, ...rci.Query) ([]json.RawMessage, []byte, error)
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
