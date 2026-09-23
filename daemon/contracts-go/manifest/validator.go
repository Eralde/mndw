// Package manifest is the language-neutral manifest validator. Its verdicts
// are kept in parity with frontend/sdk/src/manifest-schema.ts by the shared
// fixture corpus.
package manifest

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/text/language"
)

type Type string

const (
	TypeWidget Type = "widget"
	TypePage   Type = "page"
)

var eventPermissionRe = regexp.MustCompile(eventPermissionPattern)

func IsPersistentRCIPermission(permission string) bool {
	return slices.Contains(persistentRCIPermissions(), permission)
}

func IsEventPermission(permission string) bool {
	return eventPermissionRe.MatchString(permission)
}

func IsPermission(permission string) bool {
	return IsPersistentRCIPermission(permission) || IsEventPermission(permission)
}

type Size struct {
	W    *float64 `json:"w"`
	H    *float64 `json:"h"`
	MinW *float64 `json:"minW,omitempty"`
	MinH *float64 `json:"minH,omitempty"`
}

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
	Entry           *string  `json:"entry"`
	Icon            *string  `json:"icon,omitempty"`
	Permissions     []string `json:"permissions,omitempty"`
	Size            *Size    `json:"size,omitempty"`
	FixedHeight     *bool    `json:"fixedHeight,omitempty"`
	Route           *string  `json:"route,omitempty"`
	Backend         *Backend `json:"backend,omitempty"`
	I18n            *I18n    `json:"i18n,omitempty"`
}

type ValidationError struct {
	PluginName string
	Reason     string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("invalid manifest for %q: %s", e.PluginName, e.Reason)
}

var (
	nameRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	packageRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+_.-]*$`)
	methods   = map[string]struct{}{"GET": {}, "HEAD": {}, "POST": {}, "PUT": {}, "PATCH": {}, "DELETE": {}}
	reserved  = map[string]struct{}{"/": {}, "/login": {}, "/packages": {}, "/settings": {}}
)

const gridColumns = 12

// Validate parses and validates one manifest document.
func Validate(data []byte) (*Manifest, error) {
	var m Manifest

	if err := json.Unmarshal(data, &m); err != nil {
		return nil, &ValidationError{PluginName: pluginName(data), Reason: "manifest is not valid JSON of the expected shape: " + err.Error()}
	}

	if err := validate(&m, data); err != nil {
		return nil, err
	}

	return &m, nil
}

func validate(m *Manifest, data []byte) error {
	name := ""

	if m.Name != nil {
		name = *m.Name
	}

	fail := func(reason string) error {
		return &ValidationError{PluginName: name, Reason: reason}
	}

	if m.ManifestVersion == nil || *m.ManifestVersion != 1 {
		return fail("manifestVersion must be 1")
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

	if m.Entry == nil || *m.Entry == "" || !safeRelativePath(*m.Entry) || !hasFileName(*m.Entry) {
		return fail("entry must be a safe relative path with a file name")
	}

	permissions := make(map[string]struct{}, len(m.Permissions))

	for _, permission := range m.Permissions {
		if !IsPermission(permission) {
			return fail(fmt.Sprintf("unknown permission %q", permission))
		}

		if _, exists := permissions[permission]; exists {
			return fail(fmt.Sprintf("duplicate permission %q", permission))
		}

		permissions[permission] = struct{}{}
	}

	switch Type(*m.Type) {
	case TypeWidget:
		if err := validateSize(m.Size, fail); err != nil {
			return err
		}
	case TypePage:
		if err := validatePageRoute(m.Route, fail); err != nil {
			return err
		}
	default:
		return fail(fmt.Sprintf("type must be 'widget' or 'page', got %q", *m.Type))
	}

	if err := validateBackendShape(data, fail); err != nil {
		return err
	}

	if err := validateI18nShape(data, fail); err != nil {
		return err
	}

	if m.Backend != nil {
		if err := validateBackend(m.Backend, fail); err != nil {
			return err
		}
	}

	return nil
}

func validateI18nShape(data []byte, fail func(string) error) error {
	var envelope struct {
		I18n json.RawMessage `json:"i18n"`
	}

	if err := json.Unmarshal(data, &envelope); err != nil || len(envelope.I18n) == 0 {
		return nil
	}

	if string(envelope.I18n) == "null" {
		return fail("i18n must be an object")
	}

	var fields map[string]json.RawMessage

	if err := json.Unmarshal(envelope.I18n, &fields); err != nil || fields == nil {
		return fail("i18n must be an object")
	}

	for field := range fields {
		if field != "defaultLocale" && field != "locales" {
			return fail(fmt.Sprintf("i18n contains unknown field %q", field))
		}
	}

	var descriptor I18n

	if err := json.Unmarshal(envelope.I18n, &descriptor); err != nil {
		return fail("i18n has invalid fields: " + err.Error())
	}

	if descriptor.DefaultLocale == nil {
		return fail("i18n.defaultLocale is required")
	}

	if descriptor.Locales == nil || len(descriptor.Locales) == 0 {
		return fail("i18n.locales must contain at least one locale")
	}

	canonicalKeys := make(map[string]string, len(descriptor.Locales))

	for key, path := range descriptor.Locales {
		canonical, err := language.Parse(key)

		if err != nil {
			return fail(fmt.Sprintf("i18n locale %q is invalid: %v", key, err))
		}

		canonicalKey := canonical.String()

		if canonicalKey != key {
			return fail(fmt.Sprintf("i18n locale %q must use canonical BCP-47 spelling %q", key, canonicalKey))
		}

		if previous, exists := canonicalKeys[canonicalKey]; exists && previous != key {
			return fail(fmt.Sprintf("i18n locales %q and %q collide after canonicalization", previous, key))
		}

		canonicalKeys[canonicalKey] = key

		if !safeRelativePath(path) || !strings.HasSuffix(path, ".json") {
			return fail(fmt.Sprintf("i18n catalog path for %q must be a safe relative .json path", key))
		}
	}

	canonicalDefault, err := language.Parse(*descriptor.DefaultLocale)

	if err != nil {
		return fail(fmt.Sprintf("i18n.defaultLocale is invalid: %v", err))
	}

	if canonicalDefault.String() != *descriptor.DefaultLocale {
		return fail(fmt.Sprintf("i18n.defaultLocale must use canonical BCP-47 spelling %q", canonicalDefault.String()))
	}

	if _, exists := canonicalKeys[*descriptor.DefaultLocale]; !exists {
		return fail("i18n.defaultLocale must be present in i18n.locales")
	}

	return nil
}

func validateSize(size *Size, fail func(string) error) error {
	if size == nil {
		return fail("size is required for widgets")
	}

	if err := validateGridNumber("size.w", size.W, gridColumns, fail); err != nil {
		return err
	}

	if err := validateGridNumber("size.h", size.H, 0, fail); err != nil {
		return err
	}

	if size.MinW != nil {
		if err := validateGridNumber("size.minW", size.MinW, gridColumns, fail); err != nil {
			return err
		}

		if *size.MinW > *size.W {
			return fail("size.minW must be less than or equal to size.w")
		}
	}

	if size.MinH != nil {
		if err := validateGridNumber("size.minH", size.MinH, 0, fail); err != nil {
			return err
		}

		if *size.MinH > *size.H {
			return fail("size.minH must be less than or equal to size.h")
		}
	}

	return nil
}

func validateGridNumber(field string, value *float64, max float64, fail func(string) error) error {
	if value == nil {
		return fail(field + " is required")
	}

	if *value != math.Trunc(*value) || *value <= 0 {
		return fail(field + " must be a positive integer")
	}

	if max > 0 && *value > max {
		return fail(field + " must be at most 12 columns")
	}

	return nil
}

func validatePageRoute(route *string, fail func(string) error) error {
	if route == nil || !strings.HasPrefix(*route, "/") || strings.Count(*route, "/") != 1 || strings.ContainsAny(*route, "?#*") {
		return fail("route must be a single leading-slash segment")
	}

	if _, ok := reserved[*route]; ok {
		return fail("route is reserved by the host")
	}

	return nil
}

func validateBackendShape(data []byte, fail func(string) error) error {
	var envelope struct {
		Backend json.RawMessage `json:"backend"`
	}

	if err := json.Unmarshal(data, &envelope); err != nil || len(envelope.Backend) == 0 {
		return nil
	}

	var fields map[string]json.RawMessage

	if string(envelope.Backend) == "null" {
		return fail("backend must be an object")
	}

	if err := json.Unmarshal(envelope.Backend, &fields); err != nil {
		return fail("backend must be an object")
	}

	allowed := map[string]struct{}{"kind": {}, "protocolVersion": {}, "command": {}, "args": {}, "packages": {}, "routes": {}}

	for field := range fields {
		if _, ok := allowed[field]; !ok {
			return fail(fmt.Sprintf("backend contains unknown field %q", field))
		}
	}

	return nil
}

func validateBackend(b *Backend, fail func(string) error) error {
	if b.Kind == nil {
		return fail("backend.kind is required")
	}

	if len(b.Routes) == 0 {
		return fail("backend.routes must contain at least one route")
	}

	ids := make(map[string]struct{}, len(b.Routes))
	tuples := make(map[string]struct{}, len(b.Routes))

	for index := range b.Routes {
		route := &b.Routes[index]

		if route.ID == "" {
			return fail("backend.routes[].id is required")
		}

		if _, exists := ids[route.ID]; exists {
			return fail("backend.routes contains duplicate id")
		}

		ids[route.ID] = struct{}{}

		if route.Path == "" || !safeBackendRoutePath(route.Path) {
			return fail("backend.routes[].path must be canonical and safe")
		}

		if route.Access == "" {
			route.Access = "session"
		}

		if route.Access != "session" && route.Access != "public" {
			return fail("backend.routes[].access must be session or public")
		}

		switch *b.Kind {
		case BackendKindExec:
			if route.Transport != "http" || route.Command == "" || !safeCommand(route.Command) {
				return fail("exec backend routes must be HTTP routes with safe commands")
			}

			method := strings.ToUpper(route.Method)

			if _, ok := methods[method]; !ok {
				return fail(fmt.Sprintf("backend.routes[].method %q is not supported", route.Method))
			}

			route.Method = method
		case BackendKindService:
			if route.Transport != "http" && route.Transport != "websocket" {
				return fail("service backend route transport must be http or websocket")
			}

			if route.Transport == "http" {
				method := strings.ToUpper(route.Method)

				if _, ok := methods[method]; !ok {
					return fail(fmt.Sprintf("backend.routes[].method %q is not supported", route.Method))
				}

				route.Method = method
			} else {
				route.Method = ""
			}
		default:
			return fail(fmt.Sprintf("backend.kind must be 'exec' or 'service', got %q", *b.Kind))
		}

		if route.Transport == "http" && route.Access == "public" && route.Method != "GET" && route.Method != "HEAD" {
			return fail("public HTTP routes may only use GET or HEAD")
		}

		tuple := route.Transport + ":" + route.Path

		if route.Transport == "http" {
			tuple += ":" + route.Method
		}

		if _, exists := tuples[tuple]; exists {
			return fail("backend.routes contains duplicate route tuple")
		}

		tuples[tuple] = struct{}{}

		for _, protocol := range route.Protocols {
			if protocol == "" {
				return fail("backend.routes[].protocols entries must be non-empty")
			}
		}
	}

	for _, packageName := range b.Packages {
		if !packageRe.MatchString(packageName) {
			return fail(fmt.Sprintf("backend.packages contains invalid package name %q", packageName))
		}
	}

	switch *b.Kind {
	case BackendKindExec:
		if b.ProtocolVersion != nil || b.Command != nil || len(b.Args) > 0 {
			return fail("exec backend cannot declare service process fields")
		}
	case BackendKindService:
		if b.ProtocolVersion == nil || *b.ProtocolVersion <= 0 {
			return fail("service backend protocolVersion must be positive")
		}

		if b.Command == nil || !safeCommand(*b.Command) {
			return fail("service backend command must be safe")
		}

		for _, arg := range b.Args {
			if arg == "" || strings.ContainsAny(arg, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f") {
				return fail("service backend args must be non-empty literals without control characters")
			}
		}
	}

	return nil
}

func safeRelativePath(value string) bool {
	return value != "" && !strings.HasPrefix(value, "/") && !strings.Contains(value, "..") && !strings.Contains(value, `\`)
}

func safeCommand(value string) bool {
	if !safeRelativePath(value) || !hasFileName(value) {
		return false
	}

	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}

	return true
}

func safeBackendRoutePath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.ContainsAny(value, `\\?#`) {
		return false
	}

	decoded, err := url.PathUnescape(value)
	if err != nil || decoded != value || strings.Contains(decoded, "%") || strings.HasPrefix(decoded, "/") || strings.Contains(decoded, `\`) {
		return false
	}

	segments := strings.Split(decoded, "/")

	for index, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || (index == 0 && segment == "_mndw") {
			return false
		}
	}

	return true
}

func hasFileName(value string) bool {
	parts := strings.Split(value, "/")

	for index := len(parts) - 1; index >= 0; index-- {
		if parts[index] != "" {
			return true
		}
	}

	return false
}

func baseName(value string) string {
	parts := strings.Split(value, "/")

	return parts[len(parts)-1]
}

func pluginName(data []byte) string {
	var envelope struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(data, &envelope)

	if envelope.Name == "" {
		return "unknown"
	}

	return envelope.Name
}
