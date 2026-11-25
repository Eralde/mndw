package model

import "time"

const (
	MaxCurrentDevices    = 16
	MaxSnapshotDevices   = 16
	MaxDeviceStringBytes = 256
	MaxSnapshotBytes     = 256 * 1024

	MaxSmartctlStdoutBytes = 1 << 20
	MaxSmartctlStderrBytes = 16 << 10
	MaxSampleCounters      = 32
	MaxSampleAttributes    = 256
	MaxDiagnosticGroups    = 32
	MaxDiagnosticReasons   = 16
	SmartctlTimeout        = 10 * time.Second

	MaxQueuedOperations    = 16
	MaxCompletedOperations = 64
	MaxOperationIDBytes    = 128
	MaxRequestBytes        = 16 << 10
)

const OperationRetention = 10 * time.Minute
