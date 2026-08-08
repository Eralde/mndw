// Package protocol contains generic Go bindings for the language-neutral wire
// shapes used by host, daemon, and plugin tooling. Runtime state and
// plugin-specific payloads remain in their owning packages.
package protocol

// RouteDescriptor is the command-free capability projection shared by all
// manifest-v3 backends.
type RouteDescriptor struct {
	Transport string   `json:"transport"`
	Path      string   `json:"path"`
	Method    string   `json:"method,omitempty"`
	Protocols []string `json:"protocols,omitempty"`
}

// BackendDescriptor is the generic host-facing backend capability snapshot.
type BackendDescriptor struct {
	Routes   map[string]RouteDescriptor `json:"routes"`
	Approval string                     `json:"approval"`
	Enabled  bool                       `json:"enabled"`
}

// StructuredError is the stable machine-readable part of an API error.
type StructuredError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail"`
}

// ErrorEnvelope is the standard non-2xx response wrapper.
type ErrorEnvelope struct {
	Error StructuredError `json:"error"`
}

// SharedBundleURLVector records one versioned host bundle URL.
type SharedBundleURLVector struct {
	Kind    string `json:"kind"`
	Bundle  string `json:"bundle"`
	Version string `json:"version"`
	URL     string `json:"url"`
}

// ImportMapVector records runtime import-map targets.
type ImportMapVector struct {
	Kind    string            `json:"kind"`
	Imports map[string]string `json:"imports"`
}

// LockfileVector records the generic lock metadata stamped into plugin output.
type LockfileVector struct {
	Kind        string `json:"kind"`
	LockVersion int    `json:"lockVersion"`
	Plugin      struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"plugin"`
	Framework          string            `json:"framework"`
	SDKVersion         string            `json:"sdkVersion"`
	SharedDependencies map[string]string `json:"sharedDependencies"`
}
