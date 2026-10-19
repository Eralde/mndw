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
)

type LoadSampler struct {
	client *rci.Client
}

func NewLoadSampler(client *rci.Client) *LoadSampler {
	return &LoadSampler{client: client}
}

func (s *LoadSampler) Poll(ctx context.Context) ([]Value, error) {
	if s.client == nil {
		return []Value{{}, {}}, errors.New("telemetry RCI client is unavailable")
	}

	values, _, err := s.client.ExecuteRaw(ctx, rci.Query{Path: "show.system", Raw: true})
	if err != nil {
		return []Value{{}, {}}, fmt.Errorf("read show.system: %w", err)
	}

	if len(values) == 0 {
		return []Value{{}, {}}, errors.New("show.system returned no values")
	}

	var envelope map[string]any

	if err := json.Unmarshal(values[0], &envelope); err != nil {
		return []Value{{}, {}}, fmt.Errorf("decode show.system: %w", err)
	}

	system := nestedObject(envelope, "show", "system")

	if system == nil {
		return []Value{{}, {}}, errors.New("show.system response is missing system data")
	}

	cpu := finiteValue(system["cpuload"])
	ram := Value{}
	total := finiteValue(system["memtotal"])

	if total.Known && total.V > 0 {
		if used := parseUsedMemory(system["memory"]); used.Known {
			ram = Value{Known: true, V: used.V / total.V * 100}
		}
	}

	return []Value{cpu, ram}, nil
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

func finiteValue(value any) Value {
	switch typed := value.(type) {
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return Value{Known: true, V: typed}
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return Value{Known: true, V: parsed}
		}
	}

	return Value{}
}

func parseUsedMemory(value any) Value {
	if text, ok := value.(string); ok {
		parts := strings.SplitN(text, "/", 2)

		if len(parts) > 0 {
			return finiteValue(strings.TrimSpace(parts[0]))
		}
	}

	return finiteValue(value)
}
