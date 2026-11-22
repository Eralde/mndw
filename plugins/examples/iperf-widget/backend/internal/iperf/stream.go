package iperf

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

type EventKind int

const (
	EventInterval EventKind = iota + 1
	EventEnd
	EventError
)

type Event struct {
	Kind          EventKind
	Second        int
	BitsPerSecond float64
	ErrorText     string
}

func ParseLine(line []byte) (Event, bool, error) {
	var envelope struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}

	if err := json.Unmarshal(line, &envelope); err != nil {
		return Event{}, false, fmt.Errorf("decode iperf3 event: %w", err)
	}

	if envelope.Event == "" {
		return Event{}, false, fmt.Errorf("decode iperf3 event: missing event name")
	}

	switch envelope.Event {
	case "start":
		return Event{}, false, nil
	case "interval":
		var data struct {
			Sum struct {
				BitsPerSecond *float64 `json:"bits_per_second"`
				End           *float64 `json:"end"`
			} `json:"sum"`
		}

		if err := json.Unmarshal(envelope.Data, &data); err != nil {
			return Event{}, false, fmt.Errorf("decode iperf3 interval: %w", err)
		}

		if data.Sum.BitsPerSecond == nil || data.Sum.End == nil {
			return Event{}, false, fmt.Errorf("decode iperf3 interval: missing sum fields")
		}

		return Event{Kind: EventInterval, Second: int(math.Round(*data.Sum.End)), BitsPerSecond: *data.Sum.BitsPerSecond}, true, nil
	case "end":
		if len(envelope.Data) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Data), []byte("{}")) {
			return Event{}, false, nil
		}

		var data struct {
			SumReceived *struct {
				BitsPerSecond *float64 `json:"bits_per_second"`
			} `json:"sum_received"`
		}

		if err := json.Unmarshal(envelope.Data, &data); err != nil {
			return Event{}, false, fmt.Errorf("decode iperf3 end: %w", err)
		}

		if data.SumReceived == nil {
			return Event{}, false, nil
		}

		if data.SumReceived.BitsPerSecond == nil {
			return Event{}, false, fmt.Errorf("decode iperf3 end: missing receiver total")
		}

		return Event{Kind: EventEnd, BitsPerSecond: *data.SumReceived.BitsPerSecond}, true, nil
	case "error":
		var message string

		if err := json.Unmarshal(envelope.Data, &message); err != nil {
			return Event{}, false, fmt.Errorf("decode iperf3 error: %w", err)
		}

		return Event{Kind: EventError, ErrorText: message}, true, nil
	default:
		return Event{}, false, nil
	}
}
