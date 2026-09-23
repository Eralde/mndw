package mgmt

import (
	"bytes"
	"encoding/json"
	"flag"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"mndwd/internal/backend"
	"mndwd/internal/state"
)

var updateWireGoldens = flag.Bool("update", false, "rewrite contracts/mgmt/fixtures goldens from handler output")

// canonicalWireFixtureDir is the contracts/ source of truth. Tests read the generated
// copy under fixtures/mgmt; -update writes only here, and pnpm generate-contracts
// refreshes the copies.
var canonicalWireFixtureDir = filepath.Join("..", "..", "..", "..", "contracts", "mgmt", "fixtures")

// goldenRuntime reports fixed statuses so list output is deterministic.
type goldenRuntime struct {
	lifecycleTestRuntime
	statuses map[string]backend.RuntimeStatus
}

func (r *goldenRuntime) Status(name string) backend.RuntimeStatus {
	if status, ok := r.statuses[name]; ok {
		return status
	}

	return backend.RuntimeStatus{State: backend.StateStopped}
}

const goldenAlphaPageManifest = `{"manifestVersion":1,"name":"alpha-page","version":"1.2.0","type":"page","label":"Alpha","entry":"index.js","route":"/alpha","i18n":{"defaultLocale":"en","locales":{"en":"i18n/en.json","ru":"i18n/ru.json"}}}`

const goldenBetaServiceManifest = `{"manifestVersion":1,"name":"beta-service","version":"2.0.0","type":"widget","label":"Beta","entry":"index.js","size":{"w":6,"h":4,"minW":3,"minH":2},"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"},{"id":"terminal","transport":"websocket","path":"terminal","protocols":["tty"]}]}}`

const goldenDeltaRCIManifest = `{"manifestVersion":1,"name":"delta-rci","version":"1.0.0","type":"widget","label":"Delta","entry":"index.js","icon":"shield","size":{"w":4,"h":3},"permissions":["persistent-rci-session:read","persistent-rci-session:write","events:wan"]}`

const goldenGammaExecManifest = `{"manifestVersion":1,"name":"gamma-exec","version":"3.0.0","type":"widget","label":"Gamma","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"exec","packages":["curl"],"routes":[{"id":"run","transport":"http","method":"GET","path":"run","command":"backend/run.sh"}]}}`

// epsilon-backoff is the maximal runtime entry: every optional RuntimeStatus field is set,
// and compatible is false.
const goldenEpsilonBackoffManifest = `{"manifestVersion":1,"name":"epsilon-backoff","version":"0.9.0","type":"widget","label":"Epsilon","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"}]}}`

func seedGoldenPlugin(t *testing.T, store *state.Store, name string, approval state.Approval, enabled bool, manifestJSON string) {
	t.Helper()

	err := store.Mutate(func(st *state.State) error {
		st.Plugins[name] = &state.Plugin{
			Name:     name,
			Source:   state.SourceUpload,
			Approval: approval,
			Enabled:  enabled,
			Manifest: json.RawMessage(manifestJSON),
		}

		return nil
	})
	if err != nil {
		t.Fatalf("seed %s: %v", name, err)
	}
}

func readWireFixture(t *testing.T, name string) []byte {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join("fixtures", "mgmt", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v (run with -update, then pnpm generate-contracts)", name, err)
	}

	return raw
}

func assertWireGolden(t *testing.T, name string, actual []byte) {
	t.Helper()

	if *updateWireGoldens {
		var indented bytes.Buffer

		if err := json.Indent(&indented, actual, "", "  "); err != nil {
			t.Fatalf("indent %s: %v\n%s", name, err, actual)
		}

		indented.WriteByte('\n')

		if err := os.WriteFile(filepath.Join(canonicalWireFixtureDir, name), indented.Bytes(), 0o644); err != nil {
			t.Fatalf("write golden %s: %v", name, err)
		}

		t.Logf("updated contracts/mgmt/fixtures/%s; run pnpm generate-contracts and review the diff", name)

		return
	}

	var want, got any

	if err := json.Unmarshal(readWireFixture(t, name), &want); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}

	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatalf("decode response for %s: %v\n%s", name, err, actual)
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s drifted from contracts/mgmt/fixtures/%s (rerun with -update if intended)\n got: %s", name, name, actual)
	}
}

func readBody(t *testing.T, resp *http.Response, wantStatus int) []byte {
	t.Helper()

	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	if resp.StatusCode != wantStatus {
		t.Fatalf("status = %d, want %d: %s", resp.StatusCode, wantStatus, body)
	}

	return body
}

func TestWireGoldenFixtures(t *testing.T) {
	startedAt := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	nextAttemptAt := time.Date(2026, 9, 1, 10, 5, 0, 0, time.UTC)
	compatible := true
	incompatible := false
	runtime := &goldenRuntime{statuses: map[string]backend.RuntimeStatus{
		"beta-service": {
			State:              backend.StateReady,
			StartedAt:          &startedAt,
			RestartCount:       1,
			RequiredProtocol:   1,
			Compatible:         &compatible,
			SupportedProtocols: []int{1},
		},
		"epsilon-backoff": {
			State:               backend.StateBackoff,
			StartedAt:           &startedAt,
			ConsecutiveFailures: 3,
			RestartCount:        3,
			NextAttemptAt:       &nextAttemptAt,
			LastExit:            "exit status 1",
			LastError:           "backend protocol 1 is not supported",
			RecentStderr:        []string{"unsupported protocol 1", "exiting"},
			RequiredProtocol:    1,
			Compatible:          &incompatible,
			SupportedProtocols:  []int{2},
		},
	}}
	srv, store, _, cfg := newLifecycleHarness(t, runtime, &permissionTestController{available: true})

	seedGoldenPlugin(t, store, "alpha-page", state.ApprovalApproved, true, goldenAlphaPageManifest)
	seedGoldenPlugin(t, store, "beta-service", state.ApprovalApproved, true, goldenBetaServiceManifest)
	seedGoldenPlugin(t, store, "delta-rci", state.ApprovalApproved, true, goldenDeltaRCIManifest)
	seedGoldenPlugin(t, store, "gamma-exec", state.ApprovalPending, false, goldenGammaExecManifest)
	seedGoldenPlugin(t, store, "epsilon-backoff", state.ApprovalApproved, true, goldenEpsilonBackoffManifest)
	writeBuiltinFixture(t, cfg, "zeta-builtin", true)

	if err := store.SetGrant("delta-rci", "persistent-rci-session:read", true); err != nil {
		t.Fatalf("grant: %v", err)
	}

	for _, tc := range []struct{ path, fixture string }{
		{"/api/mgmt/list", "list.json"},
		{"/api/mgmt/pending", "pending.json"},
	} {
		resp, err := http.Get(srv.URL + tc.path)
		if err != nil {
			t.Fatalf("GET %s: %v", tc.path, err)
		}

		assertWireGolden(t, tc.fixture, readBody(t, resp, http.StatusOK))
	}

	resp := postPermission(t, srv, "delta-rci", "persistent-rci-session:write", true)

	assertWireGolden(t, "permission-entry.json", readBody(t, resp, http.StatusOK))
}

var jsonMarshalerType = reflect.TypeFor[json.Marshaler]()

// isWireLeaf reports whether t encodes as a JSON scalar or opaque value (time.Time
// and other json.Marshaler structs included), i.e. has no field names of its own.
func isWireLeaf(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Struct:
		return t.Implements(jsonMarshalerType) || reflect.PointerTo(t).Implements(jsonMarshalerType)
	case reflect.Map, reflect.Slice, reflect.Array, reflect.Pointer:
		return false
	default:
		return true
	}
}

// wireFieldName returns the JSON name of an encoded struct field, or "" when the
// field is not encoded. Embedded structs without a tag return "" and are flattened
// by the callers.
func wireFieldName(field reflect.StructField) string {
	if !field.IsExported() && !field.Anonymous {
		return ""
	}

	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")

	if name == "-" || (name == "" && field.Anonymous) {
		return ""
	}

	if name == "" {
		return field.Name
	}

	return name
}

func joinWirePath(prefix, name string) string {
	if prefix == "" {
		return name
	}

	return prefix + "." + name
}

// declareWirePaths records every JSON path t can encode. Map values are "*".
func declareWirePaths(t reflect.Type, prefix string, out map[string]bool) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	if isWireLeaf(t) {
		return
	}

	switch t.Kind() {
	case reflect.Slice, reflect.Array:
		declareWirePaths(t.Elem(), prefix, out)
	case reflect.Map:
		declareWirePaths(t.Elem(), prefix+".*", out)
	case reflect.Struct:
		for i := range t.NumField() {
			field := t.Field(i)

			if field.Anonymous && field.Tag.Get("json") == "" {
				declareWirePaths(field.Type, prefix, out)

				continue
			}

			name := wireFieldName(field)

			if name == "" {
				continue
			}

			path := joinWirePath(prefix, name)
			out[path] = true

			declareWirePaths(field.Type, path, out)
		}
	}
}

// coverWirePaths records every JSON path of t that is present in value (decoded JSON).
func coverWirePaths(t reflect.Type, value any, prefix string, out map[string]bool) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	if isWireLeaf(t) {
		return
	}

	switch t.Kind() {
	case reflect.Slice, reflect.Array:
		items, _ := value.([]any)

		for _, item := range items {
			coverWirePaths(t.Elem(), item, prefix, out)
		}
	case reflect.Map:
		object, _ := value.(map[string]any)

		for _, item := range object {
			coverWirePaths(t.Elem(), item, prefix+".*", out)
		}
	case reflect.Struct:
		object, _ := value.(map[string]any)

		for i := range t.NumField() {
			field := t.Field(i)

			if field.Anonymous && field.Tag.Get("json") == "" {
				coverWirePaths(field.Type, value, prefix, out)

				continue
			}

			name := wireFieldName(field)
			item, ok := object[name]

			if name == "" || !ok {
				continue
			}

			path := joinWirePath(prefix, name)
			out[path] = true

			coverWirePaths(field.Type, item, path, out)
		}
	}
}

// TestWireGoldensCoverEveryListEntryField fails when ListEntry (or a nested wire type)
// gains a JSON field that no golden exercises — typically a new omitempty field no
// seed sets. Seed a plugin that produces it, rerun -update, and the host's lossless
// decode test then forces the Zod schema to model it.
func TestWireGoldensCoverEveryListEntryField(t *testing.T) {
	entryType := reflect.TypeFor[ListEntry]()
	declared := make(map[string]bool)
	covered := make(map[string]bool)

	declareWirePaths(entryType, "", declared)

	for _, name := range []string{"list.json", "pending.json"} {
		var body struct {
			Plugins []any `json:"plugins"`
		}

		if err := json.Unmarshal(readWireFixture(t, name), &body); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}

		for _, entry := range body.Plugins {
			coverWirePaths(entryType, entry, "", covered)
		}
	}

	var permissionEntry any

	if err := json.Unmarshal(readWireFixture(t, "permission-entry.json"), &permissionEntry); err != nil {
		t.Fatalf("decode permission-entry.json: %v", err)
	}

	coverWirePaths(entryType, permissionEntry, "", covered)

	missing := make([]string, 0)

	for path := range declared {
		if !covered[path] {
			missing = append(missing, path)
		}
	}

	slices.Sort(missing)

	if len(missing) > 0 {
		t.Fatalf("ListEntry wire fields never exercised by contracts/mgmt/fixtures goldens: %v\n"+
			"seed a plugin in TestWireGoldenFixtures that produces them, then rerun with -update", missing)
	}
}

// declaredStringConsts parses the non-test Go files in dir and returns the values of
// every constant declared with an explicit typeName type, e.g. `X ServiceState = "x"`.
// Parsing (not a hand-kept list) means a newly added constant fails the parity test.
func declaredStringConsts(t *testing.T, dir, typeName string) []string {
	t.Helper()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}

	fset := token.NewFileSet()
	values := make([]string, 0)

	for _, entry := range entries {
		name := entry.Name()

		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}

		file, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}

		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)

			if !ok || gen.Tok != token.CONST {
				continue
			}

			for _, spec := range gen.Specs {
				valueSpec, ok := spec.(*ast.ValueSpec)

				if !ok {
					continue
				}

				ident, ok := valueSpec.Type.(*ast.Ident)

				if !ok || ident.Name != typeName {
					continue
				}

				for _, value := range valueSpec.Values {
					literal, ok := value.(*ast.BasicLit)

					if !ok || literal.Kind != token.STRING {
						t.Fatalf("%s constant in %s/%s must be a string literal", typeName, dir, name)
					}

					unquoted, err := strconv.Unquote(literal.Value)
					if err != nil {
						t.Fatalf("unquote %s: %v", literal.Value, err)
					}

					values = append(values, unquoted)
				}
			}
		}
	}

	if len(values) == 0 {
		t.Fatalf("no %s constants found in %s; did the type move?", typeName, dir)
	}

	slices.Sort(values)

	return values
}

func sortedCopy(values []string) []string {
	out := slices.Clone(values)

	slices.Sort(out)

	return out
}

func TestWireEnumsMatchContract(t *testing.T) {
	var enums struct {
		Source       []string `json:"source"`
		Approval     []string `json:"approval"`
		DepsStatus   []string `json:"depsStatus"`
		RuntimeState []string `json:"runtimeState"`
	}

	if err := json.Unmarshal(readWireFixture(t, "enums.json"), &enums); err != nil {
		t.Fatalf("decode enums.json: %v", err)
	}

	for _, tc := range []struct {
		dir, typeName string
		contract      []string
	}{
		{filepath.Join("..", "state"), "Source", enums.Source},
		{filepath.Join("..", "state"), "Approval", enums.Approval},
		{filepath.Join("..", "backend"), "ServiceState", enums.RuntimeState},
	} {
		declared := declaredStringConsts(t, tc.dir, tc.typeName)

		if !slices.Equal(declared, sortedCopy(tc.contract)) {
			t.Fatalf("%s constants %v differ from contracts/mgmt/fixtures/enums.json %v", tc.typeName, declared, tc.contract)
		}
	}

	// entryFrom always emits "ready"; the contract lists the wider host-accepted set.
	if !slices.Contains(enums.DepsStatus, "ready") {
		t.Fatalf("depsStatus contract %v must contain the daemon-emitted value ready", enums.DepsStatus)
	}
}
