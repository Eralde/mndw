package rci

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestExtractPreservesNestedRawBytes(t *testing.T) {
	raw := json.RawMessage(`{"show": {"version":  1.00, "name": "Guest network", "ports": [ 1, 2 ]}}`)
	tests := []struct {
		name string
		path string
		want json.RawMessage
	}{
		{name: "object", path: "show", want: json.RawMessage(`{"version":  1.00, "name": "Guest network", "ports": [ 1, 2 ]}`)},
		{name: "scalar", path: "show.version", want: json.RawMessage(`1.00`)},
		{name: "array", path: "show.ports", want: json.RawMessage(`[ 1, 2 ]`)},
		{name: "string", path: "show.name", want: json.RawMessage(`"Guest network"`)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Extract(raw, test.path)
			if err != nil {
				t.Fatal(err)
			}

			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Extract(%q) = %s, want %s", test.path, got, test.want)
			}
		})
	}
}

func TestExtractTreatsShapeMismatchesAsAbsent(t *testing.T) {
	raw := json.RawMessage(`{"show":{"items":[{"version":1}],"null":null}}`)

	for _, path := range []string{"show.items.version", "show.null.value", "show.missing.value"} {
		t.Run(path, func(t *testing.T) {
			got, err := Extract(raw, path)
			if err != nil {
				t.Fatal(err)
			}

			if got != nil {
				t.Fatalf("Extract(%q) = %s, want nil", path, got)
			}
		})
	}
}

func TestExtractRejectsInvalidPath(t *testing.T) {
	got, err := Extract(json.RawMessage(`{"show":{}}`), "show..version")
	if got != nil || !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("Extract invalid path = (%s, %v), want nil and ErrInvalidPath", got, err)
	}
}

func TestExtractPreservesSyntaxErrorCause(t *testing.T) {
	_, err := Extract(json.RawMessage(`{"show":`), "show.version")
	var syntaxErr *json.SyntaxError

	if !errors.Is(err, ErrInvalidResponse) || !errors.As(err, &syntaxErr) {
		t.Fatalf("Extract malformed JSON error = %v, want ErrInvalidResponse and *json.SyntaxError", err)
	}
}
