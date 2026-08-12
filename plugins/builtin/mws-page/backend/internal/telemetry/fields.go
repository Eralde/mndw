package telemetry

import (
	"encoding/json"
	"fmt"
	"time"
)

func ParsePersistentTelemetry(systemData, cpuData, memoryData []byte, sampledAt time.Time) (PersistentTelemetry, error) {
	var system System

	if err := json.Unmarshal(systemData, &system); err != nil {
		return PersistentTelemetry{}, fmt.Errorf("decode system telemetry: %w", err)
	}

	cpu, err := parseRrdResponse(cpuData)
	if err != nil {
		return PersistentTelemetry{}, fmt.Errorf("decode CPU RRD response: %w", err)
	}

	memory, err := parseRrdResponse(memoryData)
	if err != nil {
		return PersistentTelemetry{}, fmt.Errorf("decode memory RRD response: %w", err)
	}

	return PersistentTelemetry{SampledAt: sampledAt, System: system, CPURRD: cpu, MemoryRRD: memory}, nil
}

func parseRrdResponse(data []byte) (RrdResponse, error) {
	if len(data) == 0 {
		return RrdResponse{Data: []RrdTick{}}, nil
	}

	var response RrdResponse

	if err := json.Unmarshal(data, &response); err != nil {
		return RrdResponse{}, fmt.Errorf("decode RRD response: %w", err)
	}

	return response, nil
}
