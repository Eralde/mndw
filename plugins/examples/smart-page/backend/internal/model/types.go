package model

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type ID string
type Text string
type DateTime string

type Target struct {
	Path         string
	Type         string
	BindingToken string
}

type Command struct {
	Target Target
	Mode   string
}

type CommandResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	Failure  string
}

const (
	FailureBinaryUnavailable = "binary-unavailable"
	FailureCanceled          = "canceled"
	FailureInvalidCommand    = "invalid-command"
	FailureOutputLimit       = "output-limit"
	FailurePermissionDenied  = "permission-denied"
	FailureStartFailed       = "start-failed"
	FailureTimeout           = "timeout"
	FailureWaitFailed        = "wait-failed"
)

type Health string

const (
	HealthPassed  Health = "passed"
	HealthFailed  Health = "failed"
	HealthUnknown Health = "unknown"
)

type Level string

const (
	LevelCritical Level = "critical"
	LevelWarning  Level = "warning"
	LevelNormal   Level = "normal"
	LevelUnknown  Level = "unknown"
)

type Reason string

const (
	ReasonSmartHealthFailed          Reason = "smart-health-failed"
	ReasonATACurrentThresholdFailure Reason = "ata-current-threshold-failure"
	ReasonNVMeCriticalWarning        Reason = "nvme-critical-warning"
	ReasonNVMeSpareBelowThreshold    Reason = "nvme-spare-below-threshold"
	ReasonNVMePercentageUsed         Reason = "nvme-percentage-used"
	ReasonATAPendingSectors          Reason = "ata-pending-sectors"
	ReasonATAUncorrectableSectors    Reason = "ata-uncorrectable-sectors"
	ReasonNoHealthData               Reason = "no-health-data"
	ReasonNoApplicableWarning        Reason = "no-applicable-warning"
)

type CollectionStatus string

const (
	CollectionOK               CollectionStatus = "ok"
	CollectionSleeping         CollectionStatus = "sleeping"
	CollectionUnsupported      CollectionStatus = "unsupported"
	CollectionPermissionDenied CollectionStatus = "permission-denied"
	CollectionTimeout          CollectionStatus = "timeout"
	CollectionInvalidOutput    CollectionStatus = "invalid-output"
	CollectionCommandFailed    CollectionStatus = "command-failed"
	CollectionDisconnected     CollectionStatus = "disconnected"
	CollectionNeverRead        CollectionStatus = "never-read"
)

type Mode string

const (
	ModeOff         Mode = "off"
	ModeAllowWake   Mode = "allow-wake"
	ModeStandbyOnly Mode = "standby-only"
)

type PollingStatus string

const (
	PollingActive          PollingStatus = "active"
	PollingNeedsValidation PollingStatus = "needs-validation"
	PollingSuspended       PollingStatus = "suspended"
)

type OperationStatus string

const (
	OperationQueued    OperationStatus = "queued"
	OperationRunning   OperationStatus = "running"
	OperationSucceeded OperationStatus = "succeeded"
	OperationFailed    OperationStatus = "failed"
	OperationCancelled OperationStatus = "cancelled"
)

type OperationKind string

const (
	OperationDiscover OperationKind = "discover"
	OperationRefresh  OperationKind = "refresh"
)

type SmartdStatus string

const (
	SmartdDetected    SmartdStatus = "detected"
	SmartdNotDetected SmartdStatus = "not-detected"
	SmartdUnknown     SmartdStatus = "unknown"
)

type ClockStatus string

const (
	ClockValid    ClockStatus = "valid"
	ClockInvalid  ClockStatus = "invalid"
	ClockRollback ClockStatus = "rollback"
)

type PersistenceStatus string

const (
	PersistenceEnabled  PersistenceStatus = "enabled"
	PersistenceDisabled PersistenceStatus = "disabled"
	PersistenceDegraded PersistenceStatus = "degraded"
)

type Protocol string

const (
	ProtocolATA     Protocol = "ata"
	ProtocolNVMe    Protocol = "nvme"
	ProtocolSCSI    Protocol = "scsi"
	ProtocolUnknown Protocol = "unknown"
)

type BindingStatus string

const (
	BindingProvisional  BindingStatus = "provisional"
	BindingValidated    BindingStatus = "validated"
	BindingDisconnected BindingStatus = "disconnected"
)

type DeviceTypeSource string

const (
	DeviceTypeSourceScan DeviceTypeSource = "scan"
	DeviceTypeSourceUser DeviceTypeSource = "user"
)

type DeviceTypeOverride string

const (
	DeviceTypeSAT        DeviceTypeOverride = "sat"
	DeviceTypeSCSI       DeviceTypeOverride = "scsi"
	DeviceTypeNVMe       DeviceTypeOverride = "nvme"
	DeviceTypeSNTASMedia DeviceTypeOverride = "sntasmedia"
	DeviceTypeSNTJMicron DeviceTypeOverride = "sntjmicron"
	DeviceTypeSNTRealtek DeviceTypeOverride = "sntrealtek"
)

type HistoryReason string

const (
	HistoryIdentityUnreliable HistoryReason = "identity-unreliable"
	HistoryClockInvalid       HistoryReason = "clock-invalid"
)

type Assessment struct {
	Level        Level    `json:"level"`
	Reasons      []Reason `json:"reasons"`
	RulesVersion int      `json:"rulesVersion"`
}

type Identity struct {
	Reliable      bool    `json:"reliable"`
	Model         *Text   `json:"model"`
	Serial        *Text   `json:"serial"`
	WWN           *Text   `json:"wwn"`
	CapacityBytes *string `json:"capacityBytes"`
}

type Counter struct {
	Name  Text   `json:"name"`
	Value string `json:"value"`
	Unit  Text   `json:"unit"`
}

type HistoryCounter = Counter

type Attribute struct {
	ID         *int     `json:"id"`
	Name       Text     `json:"name"`
	Raw        *Text    `json:"raw"`
	Normalized *float64 `json:"normalized"`
	Threshold  *float64 `json:"threshold"`
	WhenFailed string   `json:"-"`
}

type Capabilities struct {
	Attributes           bool `json:"attributes"`
	Temperature          bool `json:"temperature"`
	StandbyOnlyValidated bool `json:"standbyOnlyValidated"`
}

type Sample struct {
	SchemaVersion               int          `json:"schemaVersion"`
	DeviceID                    ID           `json:"deviceId"`
	SampledAt                   DateTime     `json:"sampledAt"`
	Protocol                    Protocol     `json:"protocol"`
	Identity                    Identity     `json:"identity"`
	TemperatureC                *float64     `json:"temperatureC"`
	PowerOnHours                *string      `json:"powerOnHours"`
	RotationRate                *int         `json:"rotationRate"`
	Health                      Health       `json:"health"`
	Assessment                  Assessment   `json:"assessment"`
	Counters                    []Counter    `json:"counters"`
	Capabilities                Capabilities `json:"capabilities"`
	Attributes                  []Attribute  `json:"attributes"`
	NVMeAvailableSpareThreshold *string      `json:"-"`
}

type Collection struct {
	Status   CollectionStatus `json:"status"`
	ExitCode *int             `json:"exitCode"`
}

type Freshness struct {
	LastAttemptAt *DateTime `json:"lastAttemptAt"`
	LastSuccessAt *DateTime `json:"lastSuccessAt"`
	Stale         bool      `json:"stale"`
}

type Polling struct {
	Mode    Mode          `json:"mode"`
	Status  PollingStatus `json:"status"`
	NextDue *DateTime     `json:"nextDue"`
}

type Device struct {
	DeviceID         ID               `json:"deviceId"`
	Path             Text             `json:"path"`
	DeviceType       Text             `json:"deviceType"`
	DeviceTypeSource DeviceTypeSource `json:"deviceTypeSource"`
	USBBridge        *Text            `json:"usbBridge"`
	Binding          BindingStatus    `json:"binding"`
	Sample           *Sample          `json:"sample"`
	Collection       Collection       `json:"collection"`
	Freshness        Freshness        `json:"freshness"`
	Polling          *Polling         `json:"polling"`
	Truncated        bool             `json:"truncated"`
}

type DeviceTypeResponse struct {
	SchemaVersion    int              `json:"schemaVersion"`
	DeviceID         ID               `json:"deviceId"`
	DeviceType       Text             `json:"deviceType"`
	DeviceTypeSource DeviceTypeSource `json:"deviceTypeSource"`
}

type UtilityDiagnostic struct {
	Path      *Text `json:"path"`
	Version   *Text `json:"version"`
	Available bool  `json:"available"`
}

type SmartdDiagnostic struct {
	Status    SmartdStatus `json:"status"`
	CheckedAt DateTime     `json:"checkedAt"`
	Reason    *Text        `json:"reason"`
}

type Diagnostics struct {
	CheckedAt DateTime          `json:"checkedAt"`
	EUID      uint32            `json:"euid"`
	EGID      uint32            `json:"egid"`
	Groups    []uint32          `json:"groups"`
	Utility   UtilityDiagnostic `json:"utility"`
	Smartd    SmartdDiagnostic  `json:"smartd"`
	Reasons   []Text            `json:"reasons"`
}

type Persistence struct {
	Status      PersistenceStatus `json:"status"`
	LastFlushAt *DateTime         `json:"lastFlushAt"`
	DirtySince  *DateTime         `json:"dirtySince"`
	DataDir     *Text             `json:"dataDir"`
}

type Snapshot struct {
	SchemaVersion         int          `json:"schemaVersion"`
	ServerNow             DateTime     `json:"serverNow"`
	ClockStatus           ClockStatus  `json:"clockStatus"`
	Devices               []Device     `json:"devices"`
	Diagnostics           Diagnostics  `json:"diagnostics"`
	Config                *Config      `json:"config"`
	Persistence           *Persistence `json:"persistence"`
	Truncated             bool         `json:"truncated"`
	DisconnectedTruncated bool         `json:"disconnectedTruncated"`
}

type OperationResult interface {
	operationResult()
}

type DiscoverResult struct {
	Kind      OperationKind `json:"kind"`
	DeviceIDs []ID          `json:"deviceIds"`
	Truncated bool          `json:"truncated"`
	ExitCode  int           `json:"exitCode"`
}

func (DiscoverResult) operationResult() {}

type RefreshResult struct {
	Kind           OperationKind `json:"kind"`
	DeviceID       ID            `json:"deviceId"`
	ExitCode       int           `json:"exitCode"`
	SampleAccepted bool          `json:"sampleAccepted"`
}

func (RefreshResult) operationResult() {}

type ErrorDetail struct {
	Code Text `json:"code"`
}

type Operation struct {
	SchemaVersion int             `json:"schemaVersion"`
	ID            ID              `json:"id"`
	Kind          OperationKind   `json:"kind"`
	DeviceID      *ID             `json:"deviceId"`
	Status        OperationStatus `json:"status"`
	CreatedAt     DateTime        `json:"createdAt"`
	CompletedAt   *DateTime       `json:"completedAt"`
	Result        OperationResult `json:"result"`
	Error         *ErrorDetail    `json:"error"`
}

func (operation *Operation) UnmarshalJSON(data []byte) error {
	var wire struct {
		SchemaVersion int             `json:"schemaVersion"`
		ID            ID              `json:"id"`
		Kind          OperationKind   `json:"kind"`
		DeviceID      *ID             `json:"deviceId"`
		Status        OperationStatus `json:"status"`
		CreatedAt     DateTime        `json:"createdAt"`
		CompletedAt   *DateTime       `json:"completedAt"`
		Result        json.RawMessage `json:"result"`
		Error         *ErrorDetail    `json:"error"`
	}

	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}

	*operation = Operation{
		SchemaVersion: wire.SchemaVersion,
		ID:            wire.ID,
		Kind:          wire.Kind,
		DeviceID:      wire.DeviceID,
		Status:        wire.Status,
		CreatedAt:     wire.CreatedAt,
		CompletedAt:   wire.CompletedAt,
		Error:         wire.Error,
	}

	if len(wire.Result) == 0 || bytes.Equal(wire.Result, []byte("null")) {
		return nil
	}

	var resultKind struct {
		Kind OperationKind `json:"kind"`
	}

	if err := json.Unmarshal(wire.Result, &resultKind); err != nil {
		return fmt.Errorf("decode operation result kind: %w", err)
	}

	switch resultKind.Kind {
	case OperationDiscover:
		var result DiscoverResult

		if err := json.Unmarshal(wire.Result, &result); err != nil {
			return fmt.Errorf("decode discover result: %w", err)
		}

		if wire.Kind != result.Kind {
			return fmt.Errorf("operation kind %q does not match result kind %q", wire.Kind, result.Kind)
		}

		operation.Result = result
	case OperationRefresh:
		var result RefreshResult

		if err := json.Unmarshal(wire.Result, &result); err != nil {
			return fmt.Errorf("decode refresh result: %w", err)
		}

		if wire.Kind != result.Kind {
			return fmt.Errorf("operation kind %q does not match result kind %q", wire.Kind, result.Kind)
		}

		operation.Result = result
	default:
		return fmt.Errorf("unknown operation result kind %q", resultKind.Kind)
	}

	return nil
}

type AcceptedOperation struct {
	SchemaVersion int `json:"schemaVersion"`
	OperationID   ID  `json:"operationId"`
}

type APIError struct {
	SchemaVersion int         `json:"schemaVersion"`
	Error         ErrorDetail `json:"error"`
}

type DeviceConfig struct {
	DeviceID ID   `json:"deviceId"`
	Mode     Mode `json:"mode"`
}

type Config struct {
	SchemaVersion     int            `json:"schemaVersion"`
	Revision          string         `json:"revision"`
	PersistentHistory bool           `json:"persistentHistory"`
	Devices           []DeviceConfig `json:"devices"`
}

type SettingsDevice struct {
	DeviceID                   ID    `json:"deviceId"`
	Mode                       Mode  `json:"mode"`
	AcknowledgeWake            *bool `json:"acknowledgeWake,omitempty"`
	AcknowledgeSleepValidation *bool `json:"acknowledgeSleepValidation,omitempty"`
}

type SettingsRequest struct {
	ExpectedRevision  string           `json:"expectedRevision"`
	PersistentHistory bool             `json:"persistentHistory"`
	Devices           []SettingsDevice `json:"devices"`
}

type TemperatureSummary struct {
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
	Last float64 `json:"last"`
}

type Bucket struct {
	HourStart     DateTime            `json:"hourStart"`
	FirstSampleAt DateTime            `json:"firstSampleAt"`
	LastSampleAt  DateTime            `json:"lastSampleAt"`
	SampleCount   uint32              `json:"sampleCount"`
	TemperatureC  *TemperatureSummary `json:"temperatureC"`
	Counters      []HistoryCounter    `json:"counters"`
	Assessment    Assessment          `json:"assessment"`
}

type TimeRange struct {
	From DateTime `json:"from"`
	To   DateTime `json:"to"`
}

type Coverage struct {
	SampleCount    uint64 `json:"sampleCount"`
	CoveredSeconds uint64 `json:"coveredSeconds"`
	WindowSeconds  uint64 `json:"windowSeconds"`
}

type HistoryResponse struct {
	SchemaVersion int            `json:"schemaVersion"`
	DeviceID      ID             `json:"deviceId"`
	ServerNow     DateTime       `json:"serverNow"`
	ClockStatus   ClockStatus    `json:"clockStatus"`
	From          DateTime       `json:"from"`
	To            DateTime       `json:"to"`
	Buckets       []Bucket       `json:"buckets"`
	Gaps          []TimeRange    `json:"gaps"`
	Coverage      Coverage       `json:"coverage"`
	Truncated     bool           `json:"truncated"`
	Reason        *HistoryReason `json:"reason"`
}
