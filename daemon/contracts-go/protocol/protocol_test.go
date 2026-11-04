package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func readGolden(t *testing.T, name string) []byte {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "fixtures", "protocol", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}

	return data
}

func TestBackendDescriptorGolden(t *testing.T) {
	var vector struct {
		Kind       string            `json:"kind"`
		Descriptor BackendDescriptor `json:"descriptor"`
	}

	if err := json.Unmarshal(readGolden(t, "backend-descriptor.golden.json"), &vector); err != nil {
		t.Fatalf("decode backend descriptor: %v", err)
	}

	if vector.Kind != "backend-descriptor" {
		t.Fatalf("kind = %q, want backend-descriptor", vector.Kind)
	}

	if vector.Descriptor.Routes["status"].Method != "GET" {
		t.Fatalf("status method = %q, want GET", vector.Descriptor.Routes["status"].Method)
	}

	if vector.Descriptor.Routes["events"].Path != "events" {
		t.Fatalf("events path = %q, want events", vector.Descriptor.Routes["events"].Path)
	}

	if vector.Descriptor.Approval != "approved" || !vector.Descriptor.Enabled {
		t.Fatalf("unexpected descriptor gates: %+v", vector.Descriptor)
	}
}

func TestErrorEnvelopeGolden(t *testing.T) {
	var vector struct {
		Kind     string        `json:"kind"`
		Response ErrorEnvelope `json:"response"`
	}

	if err := json.Unmarshal(readGolden(t, "error-envelope.golden.json"), &vector); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}

	if vector.Kind != "error-envelope" || vector.Response.Error.Code != "NOT_APPROVED" {
		t.Fatalf("unexpected error envelope: %+v", vector)
	}
}

func TestSharedDependencyVectors(t *testing.T) {
	t.Run("bundle URL", func(t *testing.T) {
		var vector SharedBundleURLVector

		if err := json.Unmarshal(readGolden(t, "shared-bundle-url.golden.json"), &vector); err != nil {
			t.Fatalf("decode bundle URL: %v", err)
		}

		if vector.Kind != "shared-bundle-url" || vector.URL != "/shared/rxjs@7.8.2.js" {
			t.Fatalf("unexpected bundle URL: %+v", vector)
		}
	})

	t.Run("import map", func(t *testing.T) {
		var vector ImportMapVector

		if err := json.Unmarshal(readGolden(t, "import-map.golden.json"), &vector); err != nil {
			t.Fatalf("decode import map: %v", err)
		}

		if vector.Imports["@angular/core"] != vector.Imports["@angular/core/rxjs-interop"] {
			t.Fatalf("Angular imports do not share a bundle: %+v", vector.Imports)
		}
	})

	t.Run("lockfile", func(t *testing.T) {
		var vector LockfileVector

		if err := json.Unmarshal(readGolden(t, "lockfile.golden.json"), &vector); err != nil {
			t.Fatalf("decode lockfile: %v", err)
		}

		if vector.LockVersion != 1 || vector.SDKVersion != "1.0.0" || vector.SharedDependencies["rxjs"] != "7.8.2" {
			t.Fatalf("unexpected lockfile: %+v", vector)
		}
	})
}

func TestMalformedGoldenVectorIsRejected(t *testing.T) {
	var vector BackendDescriptor

	if err := json.Unmarshal([]byte(`{"endpoints":`), &vector); err == nil {
		t.Fatal("malformed backend descriptor was accepted")
	}
}
