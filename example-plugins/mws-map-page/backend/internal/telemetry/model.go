package telemetry

import "time"

type Vitals struct {
	CPU         float64   `json:"cpu"`
	MemoryUsed  uint64    `json:"memoryUsed"`
	MemoryTotal uint64    `json:"memoryTotal"`
	SampledAt   time.Time `json:"sampledAt"`
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
	CredState     string     `json:"credState"`
	LastRefreshAt *time.Time `json:"lastRefreshAt"`
	Nodes         []Node     `json:"nodes"`
}

type Snapshot struct {
	Nodes []Node `json:"nodes"`
}
