package manifest

import (
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
