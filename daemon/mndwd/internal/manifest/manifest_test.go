package manifest

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixturesDir is the SDK's shared manifest corpus, consumed read-only. It is the
// same set of files the Zod suite iterates; the two validators must agree on every
// file. Relative path (not go:embed) because it lives outside this Go module.
const fixturesDir = "fixtures/manifests"

func TestValidateAcceptsManifestVersionOne(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"version-one","version":"1.0.0","type":"widget","label":"Version One","entry":"index.js","size":{"w":2,"h":2}}`)

	parsed, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate version one manifest: %v", err)
	}

	if parsed.ManifestVersion == nil || *parsed.ManifestVersion != 1 {
		t.Fatalf("ManifestVersion = %v, want 1", parsed.ManifestVersion)
	}
}

func TestValidateClassifiesUnsupportedManifestVersion(t *testing.T) {
	data := []byte(`{"manifestVersion":999,"name":"unsupported-version","version":"1.0.0","type":"widget","label":"Unsupported Version","entry":"index.js","size":{"w":2,"h":2}}`)

	_, err := Validate(data)
	var versionErr *UnsupportedVersionError

	if !errors.As(err, &versionErr) {
		t.Fatalf("Validate error = %v, want UnsupportedVersionError", err)
	}

	if versionErr.Version != 999 {
		t.Fatalf("Unsupported version = %d, want 999", versionErr.Version)
	}
}

func TestValidFixturesAccepted(t *testing.T) {
	files := readFixtures(t, "valid")

	if len(files) < 8 {
		t.Fatalf("expected >= 8 valid fixtures, found %d — corpus not located?", len(files))
	}

	for _, path := range files {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			if _, err := Validate(data); err != nil {
				t.Errorf("expected valid manifest to be accepted, got: %v", err)
			}
		})
	}
}

func TestInvalidFixturesRejected(t *testing.T) {
	files := readFixtures(t, "invalid")

	if len(files) < 20 {
		t.Fatalf("expected >= 20 invalid fixtures, found %d — corpus not located?", len(files))
	}

	for _, path := range files {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			if _, err := Validate(data); err == nil {
				t.Errorf("expected invalid manifest to be rejected, but it was accepted")
			}
		})
	}
}

func TestValidateFixedHeightRoundTrips(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"fixed-widget","version":"0.1.0","type":"widget","label":"Fixed","entry":"index.js","size":{"w":4,"h":3},"fixedHeight":true}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate fixedHeight manifest: %v", err)
	}

	if manifest.FixedHeight == nil || !*manifest.FixedHeight {
		t.Fatalf("FixedHeight = %v, want non-nil true", manifest.FixedHeight)
	}
}

func TestValidatePersistentRCIPermissionRoundTrips(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"persistent-session-widget","version":"0.1.0","type":"widget","label":"Persistent","entry":"index.js","size":{"w":4,"h":3},"permissions":["persistent-rci-session:read"]}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate persistent permission manifest: %v", err)
	}

	if len(manifest.Permissions) != 1 || manifest.Permissions[0] != "persistent-rci-session:read" {
		t.Fatalf("Permissions = %#v, want persistent-rci-session:read", manifest.Permissions)
	}
}

func TestValidateUnknownPermissionRejects(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"unknown-permission-widget","version":"0.1.0","type":"widget","label":"Unknown","entry":"index.js","size":{"w":4,"h":3},"permissions":["not-a-real-permission"]}`)

	if _, err := Validate(data); err == nil {
		t.Fatal("Validate unknown permission succeeded, want error")
	}
}

func TestValidateRouteDescriptorHidesRuntimeDetails(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"secure-backend-plugin","version":"1.0.0","type":"widget","label":"Secure","entry":"index.js","size":{"w":2,"h":2},"backend":{"kind":"exec","routes":[{"id":"endpoint","transport":"http","method":"POST","path":"secure","command":"backend/script.sh"}]}}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate security flags manifest: %v", err)
	}

	if len(manifest.Backend.Routes) != 1 {
		t.Fatalf("route count = %d, want 1", len(manifest.Backend.Routes))
	}

	route := manifest.Backend.Routes[0]

	if route.Method != "POST" || route.Path != "secure" {
		t.Fatalf("route = %#v, want normalized POST route", route)
	}

	descriptor := Descriptor(manifest)
	described := descriptor.Routes["endpoint"]

	if described.Transport != "http" || described.Method != "POST" || described.Path != "secure" {
		t.Fatalf("descriptor route = %#v, want command-free route", described)
	}
}

func TestValidateExecAndDescriptorHideRuntimeDetails(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"exec","version":"3.0.0","type":"widget","label":"Exec","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"exec","routes":[{"id":"echo","transport":"http","method":"post","path":"echo","command":"backend/echo.sh"}]}}`)

	parsed, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate exec manifest: %v", err)
	}

	if parsed.ManifestVersion == nil || *parsed.ManifestVersion != 1 {
		t.Fatalf("ManifestVersion = %v, want 1", parsed.ManifestVersion)
	}

	if parsed.Backend == nil || parsed.Backend.Kind == nil || *parsed.Backend.Kind != BackendKindExec {
		t.Fatalf("Backend.Kind = %#v, want exec", parsed.Backend)
	}

	descriptor := Descriptor(parsed)

	if len(descriptor.Routes) != 1 {
		t.Fatalf("route count = %d, want 1", len(descriptor.Routes))
	}

	route := descriptor.Routes["echo"]

	if route.Transport != "http" || route.Method != "POST" || route.Path != "echo" {
		t.Fatalf("route = %#v, want normalized command-free route", route)
	}

	encoded := string(mustJSON(t, descriptor))

	for _, forbidden := range []string{"command", "backend/echo.sh", "kind", "protocolVersion"} {
		if strings.Contains(encoded, forbidden) {
			t.Errorf("descriptor contains forbidden runtime field %q: %s", forbidden, encoded)
		}
	}
}

func TestReviewSummarizesBackendCapabilities(t *testing.T) {
	data := []byte(`{"manifestVersion":1,"name":"service","version":"1.0.0","type":"widget","label":"Service","entry":"index.js","size":{"w":4,"h":3},"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","args":["--foreground"],"packages":["ttyd"],"routes":[{"id":"health","transport":"http","method":"GET","path":"health","access":"public"},{"id":"status","transport":"http","method":"GET","path":"status"}]}}`)
	parsed, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate service manifest: %v", err)
	}

	got := Review(parsed)
	want := &ApprovalReview{Kind: "service", Packages: []string{"ttyd"}, Args: []string{"--foreground"}, PublicRoutes: []string{"health"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Review() = %#v, want %#v", got, want)
	}
}

func TestReviewIsNilWithoutBackend(t *testing.T) {
	parsed, err := Validate([]byte(`{"manifestVersion":1,"name":"static","version":"1.0.0","type":"widget","label":"Static","entry":"index.js","size":{"w":4,"h":3}}`))
	if err != nil {
		t.Fatalf("Validate static manifest: %v", err)
	}

	if got := Review(parsed); got != nil {
		t.Fatalf("Review() = %#v, want nil", got)
	}
}

func TestValidateServiceAndReservedRules(t *testing.T) {
	valid := []byte(`{"manifestVersion":1,"name":"service","version":"3.0.0","type":"page","label":"Service","entry":"index.js","route":"/service","backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"status","transport":"http","method":"GET","path":"status"},{"id":"term","transport":"websocket","path":"term"}]}}`)

	if _, err := Validate(valid); err != nil {
		t.Fatalf("Validate service manifest: %v", err)
	}

	for _, data := range []string{
		`{"manifestVersion":1,"name":"bad","version":"3","type":"widget","label":"Bad","entry":"index.js","size":{"w":2,"h":2},"backend":{"kind":"exec","routes":[{"id":"ws","transport":"websocket","path":"ws","command":"backend/ws"}]}}`,
		`{"manifestVersion":1,"name":"bad","version":"3","type":"widget","label":"Bad","entry":"index.js","size":{"w":2,"h":2},"backend":{"kind":"service","protocolVersion":1,"command":"backend/server","routes":[{"id":"ready","transport":"http","method":"GET","path":"_mndw/ready"}]}}`,
	} {
		if _, err := Validate([]byte(data)); err == nil {
			t.Errorf("Validate accepted invalid manifest: %s", data)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	return data
}

func readFixtures(t *testing.T, kind string) []string {
	t.Helper()

	dir := filepath.Join(fixturesDir, kind)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read fixtures dir %s: %v", dir, err)
	}

	var files []string

	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}

	return files
}
