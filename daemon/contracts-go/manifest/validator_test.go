package manifest

import (
	"fmt"
	"os"
	"path/filepath"
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

func TestPersistentRCIPermissions(t *testing.T) {
	base := `{"manifestVersion":3,"name":"permissioned","version":"1.0.0","type":"widget","label":"Permissioned","entry":"index.js","size":{"w":2,"h":2},"permissions":%s}`

	for _, test := range []struct {
		name        string
		permissions string
		valid       bool
	}{
		{name: "read", permissions: `["persistent-rci-session:read"]`, valid: true},
		{name: "write", permissions: `["persistent-rci-session:write"]`, valid: true},
		{name: "both", permissions: `["persistent-rci-session:read","persistent-rci-session:write"]`, valid: true},
		{name: "duplicate read", permissions: `["persistent-rci-session:read","persistent-rci-session:read"]`},
		{name: "duplicate write", permissions: `["persistent-rci-session:write","persistent-rci-session:write"]`},
		{name: "retired", permissions: `["persistent-rci-session"]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Validate([]byte(fmt.Sprintf(base, test.permissions)))
			if (err == nil) != test.valid {
				t.Fatalf("Validate() error = %v, valid = %v", err, test.valid)
			}
		})
	}
}
