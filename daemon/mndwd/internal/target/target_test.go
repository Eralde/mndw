package target

import (
	"encoding/json"
	"testing"
)

func TestClassifyRCIRequest(t *testing.T) {
	telemetryBody, err := json.Marshal([]map[string]any{
		{"show": map[string]any{"system": map[string]any{}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"cpu": map[string]any{"detail": 0, "attribute": "avg"}}}}},
		{"show": map[string]any{"system": map[string]any{"rrd": map[string]any{"memory": map[string]any{"detail": 0, "attribute": "used"}}}}},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name   string
		method string
		path   string
		body   []byte
		want   Access
	}{
		{name: "show path", method: "GET", path: "rci/show/system", want: AccessRead},
		{name: "whoami path", method: "GET", path: "rci/whoami", want: AccessRead},
		{name: "telemetry batch", method: "POST", path: "rci/", body: telemetryBody, want: AccessRead},
		{name: "set body", method: "POST", path: "rci/", body: []byte(`[{"interface":{"name":"WifiMaster0","power":75}}]`), want: AccessWrite},
		{name: "mixed batch", method: "POST", path: "rci/", body: []byte(`[{"show":{"system":{}}},{"interface":{"name":"WifiMaster0","power":75}}]`), want: AccessWrite},
		{name: "malformed", method: "POST", path: "rci/", body: []byte("{"), want: AccessWrite},
		{name: "other method", method: "PUT", path: "rci/show/system", want: AccessWrite},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Classify(test.method, test.path, test.body); got != test.want {
				t.Fatalf("Classify() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestNormalizeFQDNCanonicalizesCaseAndTrailingDot(t *testing.T) {
	got, err := NormalizeFQDN(" Node-1.Keenetic.IO. ")
	if err != nil {
		t.Fatal(err)
	}

	if got != "node-1.keenetic.io" {
		t.Fatalf("NormalizeFQDN() = %q", got)
	}
}

func TestValidateRCIPathRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{"/rci/show/version", "http://public.example/rci", "rci/../secret", "rci/show?x=1", "rci/show#fragment", "rci\\show"} {
		if err := ValidateRCIPath(path); err == nil {
			t.Fatalf("ValidateRCIPath(%q) accepted unsafe path", path)
		}
	}
}
