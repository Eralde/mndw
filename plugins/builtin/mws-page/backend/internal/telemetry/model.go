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

// WifiUtilSeries carries the channel-utilization load history for one radio
// interface. Load values are percentages (0..100) ordered oldest-to-newest; T
// holds each sample's relative timestamp (device seconds) in the same order.
type WifiUtilSeries struct {
	Interface string    `json:"interface"`
	T         []float64 `json:"t"`
	Load      []float64 `json:"load"`
}

type PersistentTelemetry struct {
	SampledAt time.Time        `json:"sampledAt"`
	System    System           `json:"system"`
	CPURRD    RrdResponse      `json:"cpuRrd"`
	MemoryRRD RrdResponse      `json:"memoryRrd"`
	WifiUtil  []WifiUtilSeries `json:"wifiUtil,omitempty"`
}

type NodesResponse struct {
	LastRefreshAt          *time.Time          `json:"lastRefreshAt"`
	PersistentAvailable    bool                `json:"persistentAvailable"`
	PersistentTargetCount  int                 `json:"persistentTargetCount"`
	PersistentSessionCount int                 `json:"persistentSessionCount"`
	PersistentSessions     []PersistentSession `json:"persistentSessions"`
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
