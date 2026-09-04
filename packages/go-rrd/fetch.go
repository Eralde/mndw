package rrd

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

type FetchRow struct {
	Timestamp time.Time
	Values    []Value
}

type FetchResult struct {
	Start   time.Time
	End     time.Time
	Step    time.Duration
	DSNames []string
	Rows    []FetchRow
}

type FetchRequest struct {
	CF         string
	Resolution time.Duration
	Start      time.Time
	End        time.Time
}

func (f *File) FetchGroup(ctx context.Context, requests []FetchRequest) ([]FetchResult, error) {
	f.lock.Lock()

	defer f.lock.Unlock()

	if len(requests) == 0 {
		return nil, nil
	}

	if len(requests) > 12 {
		return nil, errors.New("rrd: fetch group too large")
	}

	if _, err := os.Stat(f.path); errors.Is(err, os.ErrNotExist) {
		return nil, ErrFileMissing
	} else if err != nil {
		return nil, fmt.Errorf("rrd: stat active file: %w", err)
	}

	results := make([]FetchResult, 0, len(requests))

	for _, request := range requests {
		if request.CF != "AVERAGE" && request.CF != "MIN" && request.CF != "MAX" {
			return nil, fmt.Errorf("rrd: unsupported fetch CF %q", request.CF)
		}

		if request.Resolution <= 0 || request.Resolution%time.Second != 0 {
			return nil, errors.New("rrd: fetch resolution must be a positive whole second duration")
		}

		if !request.End.After(request.Start) {
			return nil, errors.New("rrd: fetch end must be after start")
		}

		args := []string{
			"fetch", f.path, request.CF,
			"--resolution", strconv.FormatInt(int64(request.Resolution/time.Second), 10),
			"--start", strconv.FormatInt(request.Start.Unix(), 10),
			"--end", strconv.FormatInt(request.End.Unix(), 10),
		}
		output, err := f.executor.Run(ctx, args...)
		if err != nil {
			return nil, err
		}

		parsed, err := parseFetch(output.Stdout, request)
		if err != nil {
			return nil, err
		}

		if len(f.spec.DS) > 0 && len(parsed.DSNames) != len(f.spec.DS) {
			return nil, fmt.Errorf("rrd: fetch returned %d data sources, want %d", len(parsed.DSNames), len(f.spec.DS))
		}

		for index, dataSource := range f.spec.DS {
			if parsed.DSNames[index] != dataSource.Name {
				return nil, fmt.Errorf("rrd: fetch data-source order mismatch at %d: got %q want %q", index, parsed.DSNames[index], dataSource.Name)
			}
		}

		results = append(results, parsed)
	}

	return results, nil
}

func parseFetch(output []byte, request FetchRequest) (FetchResult, error) {
	lines := strings.Split(string(output), "\n")
	var names []string
	var rows []FetchRow

	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)

		if line == "" {
			continue
		}

		fields := strings.Fields(line)

		if len(fields) == 0 {
			continue
		}

		timestampText := strings.TrimSuffix(fields[0], ":")
		timestamp, timestampErr := strconv.ParseInt(timestampText, 10, 64)

		if timestampErr != nil {
			if len(rows) > 0 {
				return FetchResult{}, fmt.Errorf("rrd: invalid fetch line %q", line)
			}

			names = fields

			continue
		}

		if len(names) == 0 || len(fields) != len(names)+1 {
			return FetchResult{}, fmt.Errorf("rrd: fetch row has %d values, want %d", len(fields)-1, len(names))
		}

		values := make([]Value, len(names))

		for index, text := range fields[1:] {
			if strings.EqualFold(text, "nan") || strings.EqualFold(text, "-nan") {
				values[index] = Unknown

				continue
			}

			value, err := strconv.ParseFloat(text, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				return FetchResult{}, fmt.Errorf("rrd: invalid fetch value %q: %w", text, err)
			}

			values[index] = Known(value)
		}

		rows = append(rows, FetchRow{Timestamp: time.Unix(timestamp, 0), Values: values})
	}

	if len(names) == 0 {
		return FetchResult{}, errors.New("rrd: fetch output missing data-source header")
	}

	step := request.Resolution

	for index := 1; index < len(rows); index++ {
		delta := rows[index].Timestamp.Sub(rows[index-1].Timestamp)

		if delta != step {
			return FetchResult{}, fmt.Errorf("rrd: fetch row step %s, want %s", delta, step)
		}
	}

	return FetchResult{
		Start:   request.Start,
		End:     request.End,
		Step:    step,
		DSNames: names,
		Rows:    rows,
	}, nil
}
