// Package manifest is the daemon-facing alias for the generated manifest contract.
package manifest

import (
	"encoding/json"
	"fmt"

	contractmanifest "mndw.local/contracts/manifest"
)

type Type = contractmanifest.Type

const (
	TypeWidget                          = contractmanifest.TypeWidget
	TypePage                            = contractmanifest.TypePage
	PersistentRCISessionReadPermission  = contractmanifest.PersistentRCISessionReadPermission
	PersistentRCISessionWritePermission = contractmanifest.PersistentRCISessionWritePermission
	BackendKindExec                     = contractmanifest.BackendKindExec
	BackendKindService                  = contractmanifest.BackendKindService
)

func IsPersistentRCIPermission(permission string) bool {
	return contractmanifest.IsPersistentRCIPermission(permission)
}

func IsEventPermission(permission string) bool {
	return contractmanifest.IsEventPermission(permission)
}

type Size = contractmanifest.Size
type BackendKind = contractmanifest.BackendKind
type BackendRoute = contractmanifest.BackendRoute
type Backend = contractmanifest.Backend
type I18n = contractmanifest.I18n
type Manifest = contractmanifest.Manifest
type ValidationError = contractmanifest.ValidationError

type UnsupportedVersionError struct {
	Version int
}

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf("unsupported manifest version %d; manifestVersion %d is required", e.Version, supportedManifestVersion)
}

const supportedManifestVersion = 1

// Validate checks supported manifest version before applying contract validation.
func Validate(data []byte) (*Manifest, error) {
	var envelope struct {
		ManifestVersion *int `json:"manifestVersion"`
	}

	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}

	if envelope.ManifestVersion == nil || *envelope.ManifestVersion != supportedManifestVersion {
		version := 0

		if envelope.ManifestVersion != nil {
			version = *envelope.ManifestVersion
		}

		return nil, &UnsupportedVersionError{Version: version}
	}

	return contractmanifest.Validate(data)
}
