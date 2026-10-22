// Package model holds shared types and state enums of the RCI session subsystem.
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
	SupportNeedsToken  Support = "needs-token"
)

type TokenRecord struct {
	Token         string     `json:"token"`
	Support       Support    `json:"support"`
	LastCheckedAt *time.Time `json:"lastCheckedAt,omitempty"`
}

type Document struct {
	Controller *TokenRecord `json:"controller,omitempty"`
}
