// Package manifest is the Go mirror of the SDK's Zod manifest schema
// (packages/sdk/src/manifest-schema.ts). It is locked to the SDK by a shared
// fixture corpus (packages/sdk/fixtures/manifests) that both test suites run —
// any rule change must land in both. Validate returns identical accept/reject
// verdicts to the Zod validator.
package manifest

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// Type is the plugin kind (the discriminated-union discriminator).
type Type string

const (
	TypeWidget Type = "widget"
	TypePage   Type = "page"
)

// Size is a widget's grid footprint in units on the 12-column dashboard grid.
// Fields are pointers so absence is distinguishable from a zero value; JSON
// numbers land as float64 so non-integers can be rejected explicitly.
type Size struct {
	W    *float64 `json:"w"`
	H    *float64 `json:"h"`
	MinW *float64 `json:"minW,omitempty"`
	MinH *float64 `json:"minH,omitempty"`
}

// Script is a declared backend script (id + safe relative source path).
type Script struct {
	ID      string `json:"id"`
	Runtime string `json:"runtime"`
	Source  string `json:"source"`
}

// Endpoint is a declared HTTP endpoint fronting a script.
type Endpoint struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	ScriptID string `json:"scriptId"`
}

// WebSocket is a declared websocket proxy target.
type WebSocket struct {
	ID        string   `json:"id"`
	Path      string   `json:"path"`
	Target    string   `json:"target"`
	Protocols []string `json:"protocols,omitempty"`
}

// Daemon holds optional long-running start/stop hook paths.
type Daemon struct {
	Start string `json:"start"`
	Stop  string `json:"stop"`
}

// Backend is the optional server-side capability block.
type Backend struct {
	Opkg       []string    `json:"opkg,omitempty"`
	Scripts    []Script    `json:"scripts,omitempty"`
	Endpoints  []Endpoint  `json:"endpoints,omitempty"`
	WebSockets []WebSocket `json:"websockets,omitempty"`
	Daemon     *Daemon     `json:"daemon,omitempty"`
	Public     *bool       `json:"public,omitempty"`
}

// Manifest is the parsed plugin manifest. Pointer fields carry presence so
// required-field checks can distinguish "absent" from "zero".
type Manifest struct {
	ManifestVersion *int     `json:"manifestVersion"`
	Name            *string  `json:"name"`
	Version         *string  `json:"version"`
	Type            *string  `json:"type"`
	Label           *string  `json:"label"`
	Entry           *string  `json:"entry"`
	Icon            *string  `json:"icon,omitempty"`
	Size            *Size    `json:"size,omitempty"`
	FixedHeight     *bool    `json:"fixedHeight,omitempty"`
	Route           *string  `json:"route,omitempty"`
	Backend         *Backend `json:"backend,omitempty"`
}

// ValidationError is returned when a manifest fails validation. Reason is the
// first rule violated (order need not match Zod — the fixture suite only asserts
// accept/reject, and the human message is advisory).
type ValidationError struct {
	PluginName string
	Reason     string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("invalid manifest for %q: %s", e.PluginName, e.Reason)
}

var (
	nameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	opkgRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9+_.-]*$`)
	routeRe  = regexp.MustCompile(`^/[^/?#*]+$`)
	methods  = map[string]struct{}{"GET": {}, "POST": {}, "PUT": {}, "PATCH": {}, "DELETE": {}}
	reserved = map[string]struct{}{"/": {}, "/login": {}, "/settings": {}}
)

const gridColumns = 12

// safeRelativePath mirrors the SDK: reject absolute paths, traversal, and
// backslashes. Any path a plugin declares is interpolated into a filesystem/URL
// path, so it must stay a relative subpath.
func safeRelativePath(value string) bool {
	return !strings.HasPrefix(value, "/") &&
		!strings.Contains(value, "..") &&
		!strings.Contains(value, `\`)
}

// hasFileName mirrors the SDK: the last non-empty "/"-segment must be non-empty.
func hasFileName(value string) bool {
	parts := strings.Split(value, "/")
	last := ""
	for _, p := range parts {
		if p != "" {
			last = p
		}
	}

	return last != ""
}

// Validate parses and validates raw manifest JSON, returning the parsed Manifest
// or a *ValidationError. It mirrors the SDK Zod schema verdict-for-verdict.
func Validate(data []byte) (*Manifest, error) {
	var m Manifest
	// A type mismatch (e.g. `"backend": "not-an-object"`, a non-numeric size) is a
	// validation failure, not a daemon error — surface it as one.
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, &ValidationError{PluginName: pluginName(data), Reason: "manifest is not valid JSON of the expected shape: " + err.Error()}
	}

	if err := validate(&m); err != nil {
		return nil, err
	}

	return &m, nil
}

func validate(m *Manifest) error {
	name := ""
	if m.Name != nil {
		name = *m.Name
	}

	fail := func(reason string) error {
		return &ValidationError{PluginName: name, Reason: reason}
	}

	// --- base fields ---
	if m.ManifestVersion == nil || *m.ManifestVersion != 2 {
		return fail("manifestVersion must be 2")
	}
	if m.Name == nil || !nameRe.MatchString(*m.Name) {
		return fail("name must be lowercase alphanumeric with hyphens (e.g. my-widget)")
	}
	if m.Version == nil || *m.Version == "" {
		return fail("version is required")
	}
	if m.Type == nil {
		return fail("type is required")
	}
	if m.Label == nil || *m.Label == "" {
		return fail("label is required")
	}
	if m.Entry == nil || *m.Entry == "" {
		return fail("entry is required")
	}
	if !safeRelativePath(*m.Entry) {
		return fail("entry must be a safe relative path")
	}
	if !hasFileName(*m.Entry) {
		return fail("entry must include a file name")
	}

	// --- discriminated union on type ---
	switch Type(*m.Type) {
	case TypeWidget:
		if err := validateSize(m.Size, fail); err != nil {
			return err
		}
	case TypePage:
		if err := validateRoute(m.Route, fail); err != nil {
			return err
		}
	default:
		return fail(fmt.Sprintf("type must be 'widget' or 'page', got %q", *m.Type))
	}

	// --- optional backend ---
	if err := validateBackend(m.Backend, fail); err != nil {
		return err
	}

	return nil
}

func validateSize(size *Size, fail func(string) error) error {
	if size == nil {
		return fail("size is required for widgets")
	}
	if err := gridColumn("size.w", size.W, fail); err != nil {
		return err
	}
	if err := gridRow("size.h", size.H, fail); err != nil {
		return err
	}
	if size.MinW != nil {
		if err := gridColumn("size.minW", size.MinW, fail); err != nil {
			return err
		}
		if *size.MinW > *size.W {
			return fail("size.minW must be less than or equal to size.w")
		}
	}
	if size.MinH != nil {
		if err := gridRow("size.minH", size.MinH, fail); err != nil {
			return err
		}
		if *size.MinH > *size.H {
			return fail("size.minH must be less than or equal to size.h")
		}
	}

	return nil
}

// gridColumn: positive integer, 1..12.
func gridColumn(field string, v *float64, fail func(string) error) error {
	if err := gridRow(field, v, fail); err != nil {
		return err
	}
	if *v > gridColumns {
		return fail(field + " must be at most 12 columns")
	}

	return nil
}

// gridRow: positive integer (rows are unbounded).
func gridRow(field string, v *float64, fail func(string) error) error {
	if v == nil {
		return fail(field + " is required")
	}
	if *v != math.Trunc(*v) {
		return fail(field + " must be an integer")
	}
	if *v <= 0 {
		return fail(field + " must be positive")
	}

	return nil
}

func validateRoute(route *string, fail func(string) error) error {
	if route == nil {
		return fail("route is required for pages")
	}
	if !routeRe.MatchString(*route) {
		return fail("route must be a single leading-slash segment (e.g. /demo)")
	}
	if _, isReserved := reserved[*route]; isReserved {
		return fail("route is reserved by the host")
	}

	return nil
}

func validateBackend(b *Backend, fail func(string) error) error {
	if b == nil {
		return nil
	}

	for _, pkg := range b.Opkg {
		if !opkgRe.MatchString(pkg) {
			return fail(fmt.Sprintf("backend.opkg contains invalid package name %q", pkg))
		}
	}

	scriptIDs := make(map[string]struct{}, len(b.Scripts))
	basenames := make(map[string]struct{}, len(b.Scripts))
	for _, s := range b.Scripts {
		if s.ID == "" {
			return fail("backend.scripts[].id is required")
		}
		if s.Runtime != "sh" {
			return fail("backend.scripts[].runtime must be 'sh'")
		}
		if s.Source == "" || !safeRelativePath(s.Source) {
			return fail("backend.scripts[].source must be a safe relative path")
		}
		if !hasFileName(s.Source) {
			return fail("backend.scripts[].source must include a file name")
		}
		if _, dup := scriptIDs[s.ID]; dup {
			return fail("backend.scripts contains duplicate id")
		}
		scriptIDs[s.ID] = struct{}{}

		base := baseName(s.Source)
		if _, dup := basenames[base]; dup {
			return fail("backend.scripts contains duplicate source basename")
		}
		basenames[base] = struct{}{}
	}

	endpointIDs := make(map[string]struct{}, len(b.Endpoints))
	for _, e := range b.Endpoints {
		if e.ID == "" {
			return fail("backend.endpoints[].id is required")
		}
		if e.Path == "" || !safeRelativePath(e.Path) {
			return fail("backend.endpoints[].path must be a safe relative path")
		}
		if _, ok := methods[strings.ToUpper(e.Method)]; !ok {
			return fail(fmt.Sprintf("backend.endpoints[].method %q is not a supported HTTP method", e.Method))
		}
		if e.ScriptID == "" {
			return fail("backend.endpoints[].scriptId is required")
		}
		if _, dup := endpointIDs[e.ID]; dup {
			return fail("backend.endpoints contains duplicate id")
		}
		endpointIDs[e.ID] = struct{}{}
	}

	// endpoint.scriptId must reference a declared script.
	for _, e := range b.Endpoints {
		if _, ok := scriptIDs[e.ScriptID]; !ok {
			return fail("backend.endpoints[].scriptId must reference a declared script")
		}
	}

	wsIDs := make(map[string]struct{}, len(b.WebSockets))
	for _, ws := range b.WebSockets {
		if ws.ID == "" {
			return fail("backend.websockets[].id is required")
		}
		if ws.Path == "" || !safeRelativePath(ws.Path) {
			return fail("backend.websockets[].path must be a safe relative path")
		}
		if ws.Target == "" {
			return fail("backend.websockets[].target is required")
		}
		for _, p := range ws.Protocols {
			if p == "" {
				return fail("backend.websockets[].protocols entries must be non-empty")
			}
		}
		if _, dup := wsIDs[ws.ID]; dup {
			return fail("backend.websockets contains duplicate id")
		}
		wsIDs[ws.ID] = struct{}{}
	}

	if b.Daemon != nil {
		if b.Daemon.Start == "" || !safeRelativePath(b.Daemon.Start) || !hasFileName(b.Daemon.Start) {
			return fail("backend.daemon.start must be a safe relative path with a file name")
		}
		if b.Daemon.Stop == "" || !safeRelativePath(b.Daemon.Stop) || !hasFileName(b.Daemon.Stop) {
			return fail("backend.daemon.stop must be a safe relative path with a file name")
		}
	}

	return nil
}

// baseName returns the last non-empty "/"-segment (mirrors the SDK basename logic).
func baseName(source string) string {
	parts := strings.Split(source, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return parts[i]
		}
	}

	return ""
}

// pluginName best-effort extracts `name` from raw JSON for error reporting, even
// when the manifest is otherwise malformed.
func pluginName(data []byte) string {
	var probe struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.Name != "" {
		return probe.Name
	}

	return "unknown"
}
