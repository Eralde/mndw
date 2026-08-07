// Package manifest preserves daemon-local descriptor helpers while delegating
// manifest parsing and validation to the generated Go contract binding.
package manifest

import contractmanifest "mndw.local/contracts/manifest"

type Type = contractmanifest.Type

const (
	TypeWidget                     = contractmanifest.TypeWidget
	TypePage                       = contractmanifest.TypePage
	PersistentRCISessionPermission = contractmanifest.PersistentRCISessionPermission
)

type Size = contractmanifest.Size
type Script = contractmanifest.Script
type Endpoint = contractmanifest.Endpoint
type WebSocket = contractmanifest.WebSocket
type Daemon = contractmanifest.Daemon
type Backend = contractmanifest.Backend
type Manifest = contractmanifest.Manifest
type ValidationError = contractmanifest.ValidationError

// Validate delegates runtime validation to contracts-go while preserving the
// daemon package's existing import surface during the extraction.
func Validate(data []byte) (*Manifest, error) {
	return contractmanifest.Validate(data)
}
