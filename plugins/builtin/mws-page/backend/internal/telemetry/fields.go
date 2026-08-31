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

// ParseWifiUtilization extracts the per-sample timestamp (device seconds) and
// channel load (percent) from a `show interface channel-utilization chart`
// response. An empty payload yields nil slices so callers can treat a band with
// no data as simply absent.
func ParseWifiUtilization(chartData []byte) ([]float64, []float64, error) {
	if len(chartData) == 0 {
		return nil, nil, nil
	}

	var chart struct {
		Data []struct {
			T float64 `json:"t"`
			V struct {
				Load float64 `json:"load"`
			} `json:"v"`
		} `json:"data"`
	}

	if err := json.Unmarshal(chartData, &chart); err != nil {
		return nil, nil, fmt.Errorf("decode channel-utilization chart: %w", err)
	}

	if len(chart.Data) == 0 {
		return nil, nil, nil
	}

	times := make([]float64, 0, len(chart.Data))
	loads := make([]float64, 0, len(chart.Data))

	for _, tick := range chart.Data {
		times = append(times, tick.T)
		loads = append(loads, tick.V.Load)
	}

	return times, loads, nil
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
