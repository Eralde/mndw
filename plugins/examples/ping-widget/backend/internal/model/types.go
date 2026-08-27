package model

type Host struct {
	IP   string `json:"ip"`
	Name string `json:"name,omitempty"`
}

type Sample struct {
	LatencyMs float64 `json:"latencyMs"`
	Success   bool    `json:"success"`
	At        string  `json:"at"`
}

type HostStats struct {
	IP          string  `json:"ip"`
	Name        string  `json:"name,omitempty"`
	LastMs      float64 `json:"lastMs"`
	AvgMs       float64 `json:"avgMs"`
	MedianMs    float64 `json:"medianMs"`
	MinMs       float64 `json:"minMs"`
	MaxMs       float64 `json:"maxMs"`
	LossPercent float64 `json:"lossPercent"`
	SampleCount int     `json:"sampleCount"`
	UpdatedAt   string  `json:"updatedAt"`
}

type Request struct {
	Cmd  string          `json:"cmd"`
	Body HostUpdateInput `json:"body,omitempty"`
}

type Response struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Data    any    `json:"data,omitempty"`
}

type HostUpdateInput struct {
	Action string `json:"action"`
	IP     string `json:"ip"`
	Name   string `json:"name,omitempty"`
}
