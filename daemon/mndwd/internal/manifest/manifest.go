// Package manifest is the daemon-facing alias for the generated v3 contract.
package manifest

import (
	"encoding/json"
	"fmt"

	contractmanifest "mndw.local/contracts/manifest"
)

type Type = contractmanifest.Type

const (
	TypeWidget                     = contractmanifest.TypeWidget
	TypePage                       = contractmanifest.TypePage
	PersistentRCISessionPermission = contractmanifest.PersistentRCISessionPermission
	BackendKindExec                = contractmanifest.BackendKindExec
	BackendKindService             = contractmanifest.BackendKindService
)

type Size = contractmanifest.Size
type BackendKind = contractmanifest.BackendKind
type BackendRoute = contractmanifest.BackendRoute
type Backend = contractmanifest.Backend
type Manifest = contractmanifest.Manifest
type ValidationError = contractmanifest.ValidationError

type UnsupportedVersionError struct {
	Version int
}

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf("unsupported manifest version %d; manifestVersion 3 is required", e.Version)
}

// Validate is the v3 contract validator used by all production paths.
func Validate(data []byte) (*Manifest, error) {
	return contractmanifest.Validate(data)
}

// ValidateV3 distinguishes retired manifests so upload/update can return a
// stable unsupported-version error instead of treating them as malformed.
func ValidateV3(data []byte) (*Manifest, error) {
	var envelope struct {
		ManifestVersion *int `json:"manifestVersion"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	if envelope.ManifestVersion == nil || *envelope.ManifestVersion != 3 {
		version := 0
		if envelope.ManifestVersion != nil {
			version = *envelope.ManifestVersion
		}
		return nil, &UnsupportedVersionError{Version: version}
	}

	return Validate(data)
}
