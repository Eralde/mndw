package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	rci "mndw.local/rci"
	"mndw.local/rrd"
)

type LoadSampler struct {
	client *rci.Client
}

func NewLoadSampler(client *rci.Client) *LoadSampler {
	return &LoadSampler{client: client}
}

func (s *LoadSampler) Poll(ctx context.Context) ([]rrd.Value, error) {
	if s.client == nil {
		return []rrd.Value{rrd.Unknown, rrd.Unknown}, errors.New("telemetry RCI client is unavailable")
	}

	values, _, err := s.client.ExecuteRaw(ctx, rci.Query{Path: "show.system", Raw: true})
	if err != nil {
		return []rrd.Value{rrd.Unknown, rrd.Unknown}, fmt.Errorf("read show.system: %w", err)
	}

	if len(values) == 0 {
		return []rrd.Value{rrd.Unknown, rrd.Unknown}, errors.New("show.system returned no values")
	}

	var envelope map[string]any

	if err := json.Unmarshal(values[0], &envelope); err != nil {
		return []rrd.Value{rrd.Unknown, rrd.Unknown}, fmt.Errorf("decode show.system: %w", err)
	}

	system := nestedObject(envelope, "show", "system")

	if system == nil {
		return []rrd.Value{rrd.Unknown, rrd.Unknown}, errors.New("show.system response is missing system data")
	}

	cpu := finiteValue(system["cpuload"])
	ram := rrd.Unknown
	total := finiteValue(system["memtotal"])

	if total.Known && total.V > 0 {
		if used := parseUsedMemory(system["memory"]); used.Known {
			ram = rrd.Known(used.V / total.V * 100)
		}
	}

	return []rrd.Value{cpu, ram}, nil
}

func nestedObject(root map[string]any, path ...string) map[string]any {
	var current any = root

	for _, key := range path {
		object, ok := current.(map[string]any)

		if !ok {
			return nil
		}

		current = object[key]
	}

	object, _ := current.(map[string]any)

	return object
}

func finiteValue(value any) rrd.Value {
	switch typed := value.(type) {
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return rrd.Known(typed)
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return rrd.Known(parsed)
		}
	}

	return rrd.Unknown
}

func parseUsedMemory(value any) rrd.Value {
	if text, ok := value.(string); ok {
		parts := strings.SplitN(text, "/", 2)

		if len(parts) > 0 {
			return finiteValue(strings.TrimSpace(parts[0]))
		}
	}

	return finiteValue(value)
}
