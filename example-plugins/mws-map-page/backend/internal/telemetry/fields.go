package telemetry

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// FieldAdapter isolates firmware-dependent paths. Task 10 fills production
// paths only after live hardware confirms them.
type FieldAdapter struct {
	CPUPath         string
	MemoryUsedPath  string
	MemoryTotalPath string
}

func (a FieldAdapter) Parse(data []byte, sampledAt interface{}) (Vitals, error) {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return Vitals{}, fmt.Errorf("decode vitals: %w", err)
	}
	cpu, err := numberAt(payload, a.CPUPath)
	if err != nil {
		return Vitals{}, err
	}
	used, err := numberAt(payload, a.MemoryUsedPath)
	if err != nil {
		return Vitals{}, err
	}
	total, err := numberAt(payload, a.MemoryTotalPath)
	if err != nil {
		return Vitals{}, err
	}
	now, ok := sampledAt.(time.Time)
	if !ok {
		return Vitals{}, fmt.Errorf("invalid sample time")
	}
	return Vitals{CPU: cpu, MemoryUsed: uint64(used), MemoryTotal: uint64(total), SampledAt: now}, nil
}

func numberAt(payload map[string]any, path string) (float64, error) {
	var current any = payload
	for _, part := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return 0, fmt.Errorf("vitals field %q missing", path)
		}
		current, ok = object[part]
		if !ok {
			return 0, fmt.Errorf("vitals field %q missing", path)
		}
	}
	switch value := current.(type) {
	case float64:
		return value, nil
	case json.Number:
		return value.Float64()
	default:
		return 0, fmt.Errorf("vitals field %q is not numeric", path)
	}
}
