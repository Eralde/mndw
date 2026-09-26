// Package backend contains the manifest backend runtime. It owns bounded
// request execution, foreground service supervision, and Unix-socket routing.
package backend

import "time"

type LifecycleState string

const (
	LifecycleStarted LifecycleState = "started"
	LifecycleStopped LifecycleState = "stopped"
)

type LifecycleReason string

const (
	LifecycleReasonReconciled LifecycleReason = "reconciled"
	LifecycleReasonRemoved    LifecycleReason = "removed"
	LifecycleReasonDisabled   LifecycleReason = "disabled"
	LifecycleReasonRestarted  LifecycleReason = "restarted"
	LifecycleReasonUpdated    LifecycleReason = "updated"
	LifecycleReasonShutdown   LifecycleReason = "shutdown"
)

type BlockerReason string

const (
	BlockerNotGranted              BlockerReason = "not-granted"
	BlockerPrerequisiteUnavailable BlockerReason = "prerequisite-unavailable"
)

type ServiceState string

const (
	StateStopped         ServiceState = "stopped"
	StateCapacityBlocked ServiceState = "capacity_blocked"
	StateStarting        ServiceState = "starting"
	StateReady           ServiceState = "ready"
	StateBackoff         ServiceState = "backoff"
	StateFailed          ServiceState = "failed"
)

type Limits struct {
	MaxConcurrentExecTotal     int
	MaxConcurrentExecPerPlugin int
	MaxSupervisedServices      int
}

type RuntimeStatus struct {
	State               ServiceState `json:"state"`
	StartedAt           *time.Time   `json:"startedAt,omitempty"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
	RestartCount        int          `json:"restartCount"`
	NextAttemptAt       *time.Time   `json:"nextAttemptAt,omitempty"`
	LastExit            string       `json:"lastExit,omitempty"`
	LastError           string       `json:"lastError,omitempty"`
	RecentStderr        []string     `json:"recentStderr,omitempty"`
	RequiredProtocol    int          `json:"requiredProtocol,omitempty"`
	Compatible          *bool        `json:"compatible,omitempty"`
	SupportedProtocols  []int        `json:"supportedProtocols,omitempty"`
}
