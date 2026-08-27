package persistent

import "time"

type Diagnostics struct {
	Configured           bool                `json:"configured"`
	PluginIDPresent      bool                `json:"pluginIdPresent"`
	TelemetryPollEnabled bool                `json:"telemetryPollEnabled"`
	SocketPath           string              `json:"socketPath"`
	PollInterval         string              `json:"pollInterval"`
	IOTimeout            string              `json:"ioTimeout"`
	SessionRetention     string              `json:"sessionRetention"`
	Connected            bool                `json:"connected"`
	ConnectionAttempts   int                 `json:"connectionAttempts"`
	ReconnectCount       int                 `json:"reconnectCount"`
	LastConnectedAt      *time.Time          `json:"lastConnectedAt"`
	LastDisconnectedAt   *time.Time          `json:"lastDisconnectedAt"`
	LastDisconnectReason string              `json:"lastDisconnectReason,omitempty"`
	TargetCount          int                 `json:"targetCount"`
	TargetEnumerations   int                 `json:"targetEnumerations"`
	SessionCount         int                 `json:"sessionCount"`
	LastTargetsAt        *time.Time          `json:"lastTargetsAt"`
	LastTargetChange     *TargetChange       `json:"lastTargetChange"`
	LastTelemetryAt      *time.Time          `json:"lastTelemetryAt"`
	LastError            *DiagnosticError    `json:"lastError"`
	Targets              []TargetDiagnostics `json:"targets"`
}

type TargetChange struct {
	At      time.Time `json:"at"`
	Reason  string    `json:"reason"`
	Added   []string  `json:"added,omitempty"`
	Removed []string  `json:"removed,omitempty"`
}

type TargetDiagnostics struct {
	Identity            string               `json:"identity"`
	Name                string               `json:"name,omitempty"`
	MAC                 string               `json:"mac,omitempty"`
	Present             bool                 `json:"present"`
	SessionPresent      bool                 `json:"sessionPresent"`
	Live                bool                 `json:"live"`
	Misses              int                  `json:"misses"`
	SessionReason       string               `json:"sessionReason,omitempty"`
	FirstSeenAt         *time.Time           `json:"firstSeenAt"`
	LastSeenAt          *time.Time           `json:"lastSeenAt"`
	RemovedAt           *time.Time           `json:"removedAt"`
	LastProbeAt         *time.Time           `json:"lastProbeAt"`
	LastProbeStatus     *int                 `json:"lastProbeStatus"`
	LastProbeError      *DiagnosticError     `json:"lastProbeError"`
	LastTelemetryAt     *time.Time           `json:"lastTelemetryAt"`
	LastTelemetryError  *DiagnosticError     `json:"lastTelemetryError"`
	Telemetry           TelemetryDiagnostics `json:"telemetry"`
	LastSessionChangeAt *time.Time           `json:"lastSessionChangeAt"`
}

type TelemetryDiagnostics struct {
	System    TelemetryPhaseDiagnostics `json:"system"`
	CPURRD    TelemetryPhaseDiagnostics `json:"cpuRrd"`
	MemoryRRD TelemetryPhaseDiagnostics `json:"memoryRrd"`
}

type TelemetryPhaseDiagnostics struct {
	LastAttemptAt *time.Time       `json:"lastAttemptAt"`
	LastSuccessAt *time.Time       `json:"lastSuccessAt"`
	LastError     *DiagnosticError `json:"lastError"`
}

type DiagnosticError struct {
	Phase    string    `json:"phase"`
	Identity string    `json:"identity,omitempty"`
	Code     string    `json:"code"`
	Message  string    `json:"message"`
	Status   int       `json:"status,omitempty"`
	At       time.Time `json:"at"`
}
