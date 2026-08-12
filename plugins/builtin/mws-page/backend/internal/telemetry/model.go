package telemetry

import (
	"encoding/json"
	"time"
)

type RrdTick struct {
	T json.RawMessage `json:"t"`
	V float64         `json:"v"`
}

type RrdResponse struct {
	Data []RrdTick `json:"data"`
}

type System struct {
	Uptime   json.RawMessage `json:"uptime,omitempty"`
	CPULoad  float64         `json:"cpuload"`
	MemTotal uint64          `json:"memtotal"`
	Memory   string          `json:"memory"`
}

type PersistentTelemetry struct {
	SampledAt time.Time   `json:"sampledAt"`
	System    System      `json:"system"`
	CPURRD    RrdResponse `json:"cpuRrd"`
	MemoryRRD RrdResponse `json:"memoryRrd"`
}

type NodesResponse struct {
	LastRefreshAt       *time.Time          `json:"lastRefreshAt"`
	PersistentAvailable bool                `json:"persistentAvailable"`
	PersistentSessions  []PersistentSession `json:"persistentSessions"`
}

type PersistentSession struct {
	Mac       string               `json:"mac"`
	Live      bool                 `json:"live"`
	Power2G   PersistentRadioPower `json:"power2g"`
	Power5G   PersistentRadioPower `json:"power5g"`
	Telemetry *PersistentTelemetry `json:"telemetry,omitempty"`
}

type PersistentRadioPower struct {
	Value     *int `json:"value,omitempty"`
	Available bool `json:"available"`
}
