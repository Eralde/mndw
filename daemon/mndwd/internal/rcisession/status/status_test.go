package status

import (
	"encoding/json"
	"testing"
)

func TestValuesAreClosedAndMarshalSafely(t *testing.T) {
	values := Values()

	if len(values) != 6 {
		t.Fatalf("Values() = %#v", values)
	}

	for _, value := range values {
		if !IsValid(value) {
			t.Fatalf("IsValid(%q) = false", value)
		}
	}

	encoded, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}

	if string(encoded) != `["transient","unauthorized","validation","redemption-failed","controller-unavailable","malformed-response"]` {
		t.Fatalf("encoded values = %s", encoded)
	}
}
