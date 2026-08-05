package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

// fixturesDir is the SDK's shared manifest corpus, consumed read-only. It is the
// same set of files the Zod suite iterates; the two validators must agree on every
// file. Relative path (not go:embed) because it lives outside this Go module.
const fixturesDir = "../../../sdk/fixtures/manifests"

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
	if len(files) < 30 {
		t.Fatalf("expected >= 30 invalid fixtures, found %d — corpus not located?", len(files))
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
	data := []byte(`{"manifestVersion":2,"name":"fixed-widget","version":"0.1.0","type":"widget","label":"Fixed","entry":"index.js","size":{"w":4,"h":3},"fixedHeight":true}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate fixedHeight manifest: %v", err)
	}
	if manifest.FixedHeight == nil || !*manifest.FixedHeight {
		t.Fatalf("FixedHeight = %v, want non-nil true", manifest.FixedHeight)
	}
}

func TestValidatePersistentRCIPermissionRoundTrips(t *testing.T) {
	data := []byte(`{"manifestVersion":2,"name":"persistent-session-widget","version":"0.1.0","type":"widget","label":"Persistent","entry":"index.js","size":{"w":4,"h":3},"permissions":["persistent-rci-session"]}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate persistent permission manifest: %v", err)
	}
	if len(manifest.Permissions) != 1 || manifest.Permissions[0] != "persistent-rci-session" {
		t.Fatalf("Permissions = %#v, want persistent-rci-session", manifest.Permissions)
	}
}

func TestValidateUnknownPermissionRejects(t *testing.T) {
	data := []byte(`{"manifestVersion":2,"name":"unknown-permission-widget","version":"0.1.0","type":"widget","label":"Unknown","entry":"index.js","size":{"w":4,"h":3},"permissions":["not-a-real-permission"]}`)

	if _, err := Validate(data); err == nil {
		t.Fatal("Validate unknown permission succeeded, want error")
	}
}

func TestValidateEndpointSecurityFlagsRoundTrip(t *testing.T) {
	data := []byte(`{"manifestVersion":2,"name":"secure-backend-plugin","version":"1.0.0","type":"widget","label":"Secure","entry":"index.js","size":{"w":2,"h":2},"backend":{"scripts":[{"id":"script","runtime":"sh","source":"backend/script.sh"}],"endpoints":[{"id":"endpoint","method":"POST","path":"secure","scriptId":"script","csrf":true,"sensitive":true}]}}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate security flags manifest: %v", err)
	}
	if len(manifest.Backend.Endpoints) != 1 {
		t.Fatalf("endpoint count = %d, want 1", len(manifest.Backend.Endpoints))
	}
	endpoint := manifest.Backend.Endpoints[0]
	if !endpoint.Csrf || !endpoint.Sensitive {
		t.Fatalf("endpoint flags = csrf:%v sensitive:%v, want both true", endpoint.Csrf, endpoint.Sensitive)
	}

	descriptor := manifest.Descriptor()
	described := descriptor.Endpoints["endpoint"]
	if !described.Csrf || !described.Sensitive {
		t.Fatalf("descriptor flags = csrf:%v sensitive:%v, want both true", described.Csrf, described.Sensitive)
	}
}

func TestValidateBackendDiagnosticsRoundTrips(t *testing.T) {
	data := []byte(`{"manifestVersion":2,"name":"diagnostics-backend-plugin","version":"1.0.0","type":"widget","label":"Diagnostics","entry":"index.js","size":{"w":2,"h":2},"backend":{"diagnostics":true}}`)

	manifest, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate diagnostics manifest: %v", err)
	}
	if manifest.Backend == nil || manifest.Backend.Diagnostics == nil || !*manifest.Backend.Diagnostics {
		t.Fatalf("Backend.Diagnostics = %#v, want non-nil true", manifest.Backend)
	}
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
