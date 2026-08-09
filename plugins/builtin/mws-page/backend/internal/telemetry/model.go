package telemetry

import (
	"encoding/json"
	"time"
)

type Vitals struct {
	CPU         float64   `json:"cpu"`
	MemoryUsed  uint64    `json:"memoryUsed"`
	MemoryTotal uint64    `json:"memoryTotal"`
	SampledAt   time.Time `json:"sampledAt"`
}

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

type Node struct {
	ID                string     `json:"nodeId"`
	CID               string     `json:"cid,omitempty"`
	MAC               string     `json:"mac,omitempty"`
	Name              string     `json:"name,omitempty"`
	IP                string     `json:"ip,omitempty"`
	Online            bool       `json:"online"`
	State             string     `json:"state"`
	LastConnectedNode string     `json:"lastConnectedNode,omitempty"`
	LastSuccessAt     *time.Time `json:"lastSuccessAt"`
	Vitals            *Vitals    `json:"vitals"`
}

type NodesResponse struct {
	CredState          string              `json:"credState"`
	LastRefreshAt      *time.Time          `json:"lastRefreshAt"`
	Nodes              []Node              `json:"nodes"`
	PersistentSessions []PersistentSession `json:"persistentSessions,omitempty"`
}

type PersistentSession struct {
	Mac       string               `json:"mac"`
	Live      bool                 `json:"live"`
	Stale     bool                 `json:"stale"`
	Power2G   PersistentRadioPower `json:"power2g"`
	Power5G   PersistentRadioPower `json:"power5g"`
	Telemetry *PersistentTelemetry `json:"telemetry,omitempty"`
}

type PersistentRadioPower struct {
	Value     *int `json:"value,omitempty"`
	Available bool `json:"available"`
}

type Snapshot struct {
	Nodes []Node `json:"nodes"`
}
