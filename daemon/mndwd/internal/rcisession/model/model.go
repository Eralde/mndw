// Package model holds the shared types and state enums of the RCI session
// subsystem: the stored document shape, token records, and store/support states.
package model

import "time"

type StoreState string

const (
	StateOK            StoreState = "ok"
	StateEmpty         StoreState = "empty"
	StateDisabled      StoreState = "disabled"
	StateDecryptFailed StoreState = "decrypt-failed"
)

type Support string

const (
	SupportSupported   Support = "supported"
	SupportInvalid     Support = "invalid"
	SupportUnsupported Support = "unsupported"
	SupportUnknown     Support = "unknown"
)

type TokenRecord struct {
	Key           string     `json:"key"`
	Token         string     `json:"token"`
	Support       Support    `json:"support"`
	LastCheckedAt *time.Time `json:"lastCheckedAt,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
	RetryAfter    *time.Time `json:"retryAfter,omitempty"`
}

type Document struct {
	Controller *TokenRecord           `json:"controller,omitempty"`
	Extenders  map[string]TokenRecord `json:"extenders,omitempty"`
}
