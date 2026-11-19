package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixtureCorpusParity(t *testing.T) {
	tests := []struct {
		kind      string
		wantValid bool
	}{
		{kind: "valid", wantValid: true},
		{kind: "invalid", wantValid: false},
	}

	for _, test := range tests {
		t.Run(test.kind, func(t *testing.T) {
			directory := filepath.Join("..", "fixtures", "manifests", test.kind)
			entries, err := os.ReadDir(directory)
			if err != nil {
				t.Fatalf("read fixture directory: %v", err)
			}

			if len(entries) == 0 {
				t.Fatal("fixture directory is empty")
			}

			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}

				data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
				if err != nil {
					t.Fatalf("read %s: %v", entry.Name(), err)
				}

				_, validationErr := Validate(data)

				if (validationErr == nil) != test.wantValid {
					t.Errorf("Validate(%s) error = %v, want valid=%t", entry.Name(), validationErr, test.wantValid)
				}
			}
		})
	}
}

func TestValidatePreservesUnmarshalErrorText(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{
			name: "size shape",
			data: `{"manifestVersion":1,"name":"bad-size","version":"1.0.0","type":"widget","label":"Bad size","entry":"index.js","size":"wrong"}`,
			want: `invalid manifest for "bad-size": manifest is not valid JSON of the expected shape: json: cannot unmarshal string into Go struct field Manifest.size of type manifest.Size`,
		},
		{
			name: "backend shape",
			data: `{"manifestVersion":1,"name":"bad-backend","version":"1.0.0","type":"widget","label":"Bad backend","entry":"index.js","size":{"w":4,"h":3},"backend":"wrong"}`,
			want: `invalid manifest for "bad-backend": manifest is not valid JSON of the expected shape: json: cannot unmarshal string into Go struct field Manifest.backend of type manifest.Backend`,
		},
		{
			name: "i18n shape",
			data: `{"manifestVersion":1,"name":"bad-i18n","version":"1.0.0","type":"widget","label":"Bad i18n","entry":"index.js","size":{"w":4,"h":3},"i18n":"wrong"}`,
			want: `invalid manifest for "bad-i18n": manifest is not valid JSON of the expected shape: json: cannot unmarshal string into Go struct field Manifest.i18n of type manifest.I18n`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Validate([]byte(test.data))
			if err == nil || err.Error() != test.want {
				t.Fatalf("Validate() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestValidateRejectsRemovedFixedHeight(t *testing.T) {
	tests := []struct {
		name   string
		type_  string
		fields string
	}{
		{
			name:   "widget boolean",
			type_:  "widget",
			fields: `"size":{"w":4,"h":3},"fixedHeight":true`,
		},
		{
			name:   "widget object",
			type_:  "widget",
			fields: `"size":{"w":4,"h":3},"fixedHeight":{"value":true}`,
		},
		{
			name:   "page string",
			type_:  "page",
			fields: `"route":"/removed","fixedHeight":"ignored"`,
		},
		{
			name:   "page null",
			type_:  "page",
			fields: `"route":"/removed","fixedHeight":null`,
		},
		{
			name:   "page array",
			type_:  "page",
			fields: `"route":"/removed","fixedHeight":[]`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(`{"manifestVersion":1,"name":"removed-fixed-height","version":"1.0.0","type":"` + test.type_ + `","label":"Removed","entry":"index.js",` + test.fields + `}`)
			_, err := Validate(data)
			want := `invalid manifest for "removed-fixed-height": fixedHeight was removed in 0.3`

			if err == nil || err.Error() != want {
				t.Fatalf("Validate() error = %v, want %q", err, want)
			}
		})
	}
}

func TestValidateRejectsUnknownManifestFields(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{
			name: "unknown top-level field",
			data: `{"manifestVersion":1,"name":"unknown-top-level","version":"1.0.0","type":"widget","label":"Unknown","entry":"index.js","size":{"w":4,"h":3},"capabilites":[]}`,
			want: `invalid manifest for "unknown-top-level": manifest contains unknown field "capabilites"`,
		},
		{
			name: "unknown page field",
			data: `{"manifestVersion":1,"name":"unknown-page-field","version":"1.0.0","type":"page","label":"Unknown","entry":"index.js","route":"/unknown","analytics":true}`,
			want: `invalid manifest for "unknown-page-field": manifest contains unknown field "analytics"`,
		},
		{
			name: "unknown size field",
			data: `{"manifestVersion":1,"name":"unknown-size-field","version":"1.0.0","type":"widget","label":"Unknown","entry":"index.js","size":{"w":4,"h":3,"extra":true}}`,
			want: `invalid manifest for "unknown-size-field": size contains unknown field "extra"`,
		},
		{
			name: "removed field precedes unknown field",
			data: `{"manifestVersion":1,"name":"removed-precedes-unknown","version":"1.0.0","type":"widget","label":"Unknown","entry":"index.js","size":{"w":4,"h":3},"capabilites":[],"permissions":[]}`,
			want: `invalid manifest for "removed-precedes-unknown": permissions was renamed to capabilities in 0.3`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Validate([]byte(test.data))
			if err == nil || err.Error() != test.want {
				t.Fatalf("Validate() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestValidateSchemaHintAcceptsOnlyStrings(t *testing.T) {
	tests := []struct {
		name    string
		schema  string
		wantErr string
	}{
		{name: "empty string", schema: `""`},
		{name: "arbitrary string", schema: `"custom://editor/schema"`},
		{name: "null", schema: `null`, wantErr: `invalid manifest for "schema-hint": $schema must be a string`},
		{name: "number", schema: `42`, wantErr: `invalid manifest for "schema-hint": $schema must be a string`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(`{"$schema":` + test.schema + `,"manifestVersion":1,"name":"schema-hint","version":"1.0.0","type":"widget","label":"Schema hint","entry":"index.js","size":{"w":4,"h":3}}`)
			_, canonical, err := ValidateCanonical(data)

			if test.wantErr != "" {
				if err == nil || err.Error() != test.wantErr {
					t.Fatalf("ValidateCanonical() error = %v, want %q", err, test.wantErr)
				}

				return
			}

			if err != nil {
				t.Fatalf("ValidateCanonical() error = %v", err)
			}

			if strings.Contains(string(canonical), `"$schema"`) {
				t.Errorf("canonical manifest retained editor schema metadata: %s", canonical)
			}
		})
	}
}

func TestValidateReturnsValueManifestWithDefaults(t *testing.T) {
	tests := []struct {
		name              string
		backend           string
		wantKind          BackendKind
		wantProtocol      int
		wantCommand       string
		wantI18n          bool
		wantDefaultLocale string
	}{
		{
			name: "no backend",
		},
		{
			name:     "exec backend",
			backend:  `,"backend":{"kind":"exec","routes":[{"id":"echo","transport":"http","method":"GET","path":"echo","command":"backend/echo.sh"}]}`,
			wantKind: BackendKindExec,
		},
		{
			name:              "service backend and i18n",
			backend:           `,"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]},"i18n":{"defaultLocale":"en","locales":{"en":"i18n/en.json"}}`,
			wantKind:          BackendKindService,
			wantProtocol:      1,
			wantCommand:       "backend/server",
			wantI18n:          true,
			wantDefaultLocale: "en",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(`{"manifestVersion":1,"name":"defaults","version":"1.0.0","type":"widget","label":"Defaults","entry":"index.js","size":{"w":4,"h":3}` + test.backend + `}`)

			got, err := Validate(data)
			if err != nil {
				t.Fatalf("Validate() error = %v", err)
			}

			if got.ManifestVersion != 1 || got.Name != "defaults" || got.Version != "1.0.0" || got.Type != TypeWidget || got.Label != "Defaults" || got.Entry != "index.js" {
				t.Fatalf("validated required fields = %+v", got)
			}

			if got.Size != (Size{W: 4, H: 3}) {
				t.Errorf("validated size = %+v, want {W:4 H:3}", got.Size)
			}

			if got.Backend.Kind != test.wantKind || got.Backend.ProtocolVersion != test.wantProtocol || got.Backend.Command != test.wantCommand {
				t.Errorf("validated backend = %+v, want kind=%q protocol=%d command=%q", got.Backend, test.wantKind, test.wantProtocol, test.wantCommand)
			}

			if (got.I18n.DefaultLocale != "") != test.wantI18n || got.I18n.DefaultLocale != test.wantDefaultLocale {
				t.Errorf("validated i18n = %+v, want present=%t defaultLocale=%q", got.I18n, test.wantI18n, test.wantDefaultLocale)
			}
		})
	}
}

func TestValidateDropsForeignTypeFieldsAndReturnsCanonicalJSON(t *testing.T) {
	tests := []struct {
		name          string
		fixture       string
		manifestType  Type
		wantCanonical string
		wantRoute     string
	}{
		{
			name:          "page with empty foreign size",
			fixture:       "foreign-page-size-empty.json",
			manifestType:  TypePage,
			wantRoute:     "/foreign-empty",
			wantCanonical: `{"manifestVersion":1,"name":"foreign-page-empty","version":"1.0.0","type":"page","label":"Foreign empty","entry":"index.js","route":"/foreign-empty"}`,
		},
		{
			name:          "page with partial foreign size and invalid minimums",
			fixture:       "foreign-page-size-partial.json",
			manifestType:  TypePage,
			wantRoute:     "/foreign-partial",
			wantCanonical: `{"manifestVersion":1,"name":"foreign-page-partial","version":"1.0.0","type":"page","label":"Foreign partial","entry":"index.js","route":"/foreign-partial"}`,
		},
		{
			name:          "widget with foreign route",
			fixture:       "foreign-widget-route.json",
			manifestType:  TypeWidget,
			wantCanonical: `{"manifestVersion":1,"name":"foreign-widget-route","version":"1.0.0","type":"widget","label":"Foreign route","entry":"index.js","size":{"w":4,"h":3}}`,
		},
		{
			name:          "page with incompatible foreign size",
			fixture:       "foreign-page-size-string.json",
			manifestType:  TypePage,
			wantRoute:     "/foreign-size-string",
			wantCanonical: `{"manifestVersion":1,"name":"foreign-page-size-string","version":"1.0.0","type":"page","label":"Foreign size string","entry":"index.js","route":"/foreign-size-string"}`,
		},
		{
			name:          "page with nested incompatible foreign size",
			fixture:       "foreign-page-size-nested-invalid.json",
			manifestType:  TypePage,
			wantRoute:     "/foreign-size-nested-invalid",
			wantCanonical: `{"manifestVersion":1,"name":"foreign-page-size-nested-invalid","version":"1.0.0","type":"page","label":"Foreign nested size","entry":"index.js","route":"/foreign-size-nested-invalid"}`,
		},
		{
			name:          "widget with incompatible foreign route",
			fixture:       "foreign-widget-route-object.json",
			manifestType:  TypeWidget,
			wantCanonical: `{"manifestVersion":1,"name":"foreign-widget-route-object","version":"1.0.0","type":"widget","label":"Foreign route object","entry":"index.js","size":{"w":4,"h":3}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("..", "fixtures", "manifests", "valid", test.fixture))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			validated, canonical, err := ValidateCanonical(data)
			if err != nil {
				t.Fatalf("ValidateCanonical() error = %v", err)
			}

			if validated.Type != test.manifestType || validated.Route != test.wantRoute {
				t.Fatalf("validated type/route = %q/%q, want %q/%q", validated.Type, validated.Route, test.manifestType, test.wantRoute)
			}

			if test.manifestType == TypePage {
				if validated.Size != (Size{}) {
					t.Errorf("page retained foreign size: %+v", validated)
				}
			} else if validated.Route != "" {
				t.Errorf("widget retained foreign route %q", validated.Route)
			}

			if string(canonical) != test.wantCanonical {
				t.Errorf("canonical JSON = %s, want %s", canonical, test.wantCanonical)
			}
		})
	}
}

func TestPersistentRCICapabilities(t *testing.T) {
	base := `{"manifestVersion":1,"name":"capable","version":"1.0.0","type":"widget","label":"Capable","entry":"index.js","size":{"w":2,"h":2},"capabilities":%s}`

	for _, test := range []struct {
		name         string
		capabilities string
		valid        bool
	}{
		{name: "read", capabilities: `["persistent-rci-session:read"]`, valid: true},
		{name: "write", capabilities: `["persistent-rci-session:write"]`, valid: true},
		{name: "both", capabilities: `["persistent-rci-session:read","persistent-rci-session:write"]`, valid: true},
		{name: "duplicate read", capabilities: `["persistent-rci-session:read","persistent-rci-session:read"]`},
		{name: "duplicate write", capabilities: `["persistent-rci-session:write","persistent-rci-session:write"]`},
		{name: "retired", capabilities: `["persistent-rci-session"]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Validate([]byte(fmt.Sprintf(base, test.capabilities)))
			if (err == nil) != test.valid {
				t.Fatalf("Validate() error = %v, valid = %v", err, test.valid)
			}
		})
	}
}

func TestLegacyPermissionsFieldRequiresCapabilities(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"legacy-permissions","version":"1.0.0","type":"widget","label":"Legacy","entry":"index.js","size":{"w":2,"h":2},"permissions":["events:*"]}`)

	_, err := Validate(data)
	if err == nil || !strings.Contains(err.Error(), "permissions was renamed to capabilities in 0.3") {
		t.Fatalf("Validate() error = %v, want rename guidance", err)
	}
}

func TestLegacyIconFieldRequiresManifestUpdate(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"legacy-icon","version":"1.0.0","type":"widget","label":"Legacy","entry":"index.js","size":{"w":2,"h":2},"icon":"chart"}`)

	_, err := Validate(data)
	if err == nil || !strings.Contains(err.Error(), "icon was removed in 0.3") {
		t.Fatalf("Validate() error = %v, want removal guidance", err)
	}
}

func TestI18nManifestValidation(t *testing.T) {
	base := func(i18n string) []byte {
		return []byte(fmt.Sprintf(`{"manifestVersion":1,"name":"i18n-plugin","version":"1.0.0","type":"widget","label":"I18n plugin","entry":"index.js","size":{"w":2,"h":2},"i18n":%s}`, i18n))
	}

	tests := []struct {
		name  string
		i18n  string
		valid bool
	}{
		{
			name:  "default and alternate locales",
			i18n:  `{"defaultLocale":"en","locales":{"en":"i18n/en.json","ru":"i18n/ru.json"}}`,
			valid: true,
		},
		{
			name: "default locale missing",
			i18n: `{"defaultLocale":"de","locales":{"en":"i18n/en.json"}}`,
		},
		{
			name: "empty locales",
			i18n: `{"defaultLocale":"en","locales":{}}`,
		},
		{
			name: "unsafe path",
			i18n: `{"defaultLocale":"en","locales":{"en":"../en.json"}}`,
		},
		{
			name: "non-json path",
			i18n: `{"defaultLocale":"en","locales":{"en":"i18n/en.txt"}}`,
		},
		{
			name: "malformed locale",
			i18n: `{"defaultLocale":"en","locales":{"not a tag":"i18n/en.json"}}`,
		},
		{
			name: "non-canonical locale",
			i18n: `{"defaultLocale":"en","locales":{"EN-us":"i18n/en-us.json"}}`,
		},
		{
			name: "canonical collision",
			i18n: `{"defaultLocale":"en","locales":{"en":"i18n/en.json","EN-us":"i18n/en-us.json","en-US":"i18n/en-us-2.json"}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Validate(base(test.i18n))

			if (err == nil) != test.valid {
				t.Fatalf("Validate() error = %v, valid = %v", err, test.valid)
			}
		})
	}
}
