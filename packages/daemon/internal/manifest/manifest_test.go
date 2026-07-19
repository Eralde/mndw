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
