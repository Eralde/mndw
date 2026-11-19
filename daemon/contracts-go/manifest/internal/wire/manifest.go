package manifest

type BackendKind string

const (
	BackendKindExec    BackendKind = "exec"
	BackendKindService BackendKind = "service"
)

type BackendRoute struct {
	ID        string   `json:"id"`
	Transport string   `json:"transport"`
	Method    string   `json:"method,omitempty"`
	Path      string   `json:"path"`
	Access    string   `json:"access,omitempty"`
	Command   string   `json:"command,omitempty"`
	Protocols []string `json:"protocols,omitempty"`
}

type Size struct {
	W    *float64 `json:"w"`
	H    *float64 `json:"h"`
	MinW *float64 `json:"minW,omitempty"`
	MinH *float64 `json:"minH,omitempty"`
}

type Backend struct {
	Kind            *BackendKind   `json:"kind,omitempty"`
	ProtocolVersion *int           `json:"protocolVersion,omitempty"`
	Command         *string        `json:"command,omitempty"`
	Args            []string       `json:"args,omitempty"`
	Packages        []string       `json:"packages,omitempty"`
	Routes          []BackendRoute `json:"routes,omitempty"`
}

type I18n struct {
	DefaultLocale *string           `json:"defaultLocale"`
	Locales       map[string]string `json:"locales"`
}

type Manifest struct {
	ManifestVersion *int     `json:"manifestVersion"`
	Name            *string  `json:"name"`
	Version         *string  `json:"version"`
	Type            *string  `json:"type"`
	Label           *string  `json:"label"`
	Description     *string  `json:"description,omitempty"`
	Entry           *string  `json:"entry"`
	Capabilities    []string `json:"capabilities,omitempty"`
	Size            *Size    `json:"size,omitempty"`
	Route           *string  `json:"route,omitempty"`
	Backend         *Backend `json:"backend,omitempty"`
	I18n            *I18n    `json:"i18n,omitempty"`
}
