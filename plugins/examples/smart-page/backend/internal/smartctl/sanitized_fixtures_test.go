package smartctl

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"smart-page/internal/model"
)

type sanitizedFixture struct {
	name           string
	wantExitStatus int
	originalHashes map[string]string
}

var sanitizedFixtures = []sanitizedFixture{
	{
		name:           "ata-hdd.json",
		wantExitStatus: 0,
		originalHashes: map[string]string{
			"serial_number": "b92f76e67ae129d4a8584670a06100a15bd2ae25f964f397e49fd2c584c4b7a9",
			"wwn.oui":       "50e65b1455800c98b480cec56db88524fabd630ddd992df1a58faf5a6edd2430",
			"wwn.id":        "a78d6dd142978e1c409c733a459fc31b0af59d92a1828387731d6ad54ac13c72",
		},
	},
	{
		name:           "scsi-usb-hdd.json",
		wantExitStatus: 0,
		originalHashes: map[string]string{
			"serial_number": "aabc1e7a70ba90c7d3d4bd7fdf143a9025dd1dec0afa66870e38a5ef7f3d0b80",
		},
	},
	{
		name:           "nvme-usb-asmedia.json",
		wantExitStatus: 0,
		originalHashes: map[string]string{
			"serial_number": "1f9d8d8f5268be812902a2abd23a239282bba58f17584ed294050ee4c98ff979",
		},
	},
	{
		name:           "scsi-usb-nvme.json",
		wantExitStatus: 4,
		originalHashes: map[string]string{
			"serial_number":   "6cce2317692ce3b9d7f71ba0d17bc84fb02fe107d0fb759349e3507e706bcbb4",
			"logical_unit_id": "aab30f65fbad69956a5bb9f65bf5bf0205d8532f8dee05eee0c7c286a31e507d",
		},
	},
	{
		name:           "standby.json",
		wantExitStatus: 3,
		originalHashes: map[string]string{},
	},
}

func TestSanitizedHardwareFixtures(t *testing.T) {
	for _, fixture := range sanitizedFixtures {
		t.Run(fixture.name, func(t *testing.T) {
			path := filepath.Join("..", "..", "testdata", fixture.name)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			var document map[string]json.RawMessage

			if err := json.Unmarshal(data, &document); err != nil {
				t.Fatalf("fixture is not valid JSON: %v", err)
			}

			var smartctl struct {
				ExitStatus int `json:"exit_status"`
			}

			if err := json.Unmarshal(document["smartctl"], &smartctl); err != nil {
				t.Fatalf("decode smartctl status: %v", err)
			}

			if smartctl.ExitStatus != fixture.wantExitStatus {
				t.Fatalf("smartctl.exit_status = %d, want %d", smartctl.ExitStatus, fixture.wantExitStatus)
			}

			for field, originalHash := range fixture.originalHashes {
				value, ok := sanitizedField(document, field)

				if !ok {
					t.Errorf("sanitized field %q is missing", field)

					continue
				}

				digest := sha256.Sum256(value)

				if hex.EncodeToString(digest[:]) == originalHash {
					t.Errorf("field %q still matches original SHA-256", field)
				}
			}

			var localTime struct {
				TimeT   int64  `json:"time_t"`
				Asctime string `json:"asctime"`
			}

			if err := json.Unmarshal(document["local_time"], &localTime); err != nil {
				t.Fatalf("decode local_time: %v", err)
			}

			if localTime.TimeT != 1767225600 || localTime.Asctime != "Thu Jan  1 00:00:00 2026" {
				t.Errorf("local_time = %+v, want fixed synthetic time", localTime)
			}
		})
	}
}

// minHiddenLength skips values too short to hide anything, such as the synthetic WWN parts 0 and 1.
const minHiddenLength = 4

// TestSanitizedFixturesAreNotReversible keeps the guarded values from being a reversible transform of each other: a
// per-character shift by one or a reversal would let anyone recover the original identifiers.
func TestSanitizedFixturesAreNotReversible(t *testing.T) {
	type guardedValue struct{ label, text string }

	var values []guardedValue

	for _, fixture := range sanitizedFixtures {
		data, err := os.ReadFile(filepath.Join("..", "..", "testdata", fixture.name))
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}

		var document map[string]json.RawMessage

		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatalf("fixture %s is not valid JSON: %v", fixture.name, err)
		}

		for field := range fixture.originalHashes {
			value, ok := sanitizedField(document, field)

			if !ok {
				t.Fatalf("%s: sanitized field %q is missing", fixture.name, field)
			}

			values = append(values, guardedValue{label: fixture.name + ":" + field, text: string(value)})
		}
	}

	for _, left := range values {
		for _, right := range values {
			if left.label == right.label || len(left.text) < minHiddenLength {
				continue
			}

			if shiftedByOne(left.text, right.text) || left.text == reversed(right.text) {
				t.Errorf("%s is a one-character shift or the reversal of %s", left.label, right.label)
			}
		}
	}
}

func TestReversibleTransformDetection(t *testing.T) {
	cases := []struct {
		name         string
		value, other string
		shifted      bool
		reversal     bool
	}{
		{name: "every character plus one", value: "BCDE", other: "ABCD", shifted: true},
		{name: "every character minus one", value: "ABCD", other: "BCDE", shifted: true},
		{name: "mixed plus and minus one", value: "BADC", other: "ABCD", shifted: true},
		{name: "punctuation unchanged", value: "BCDE-2", other: "ABCD-1", shifted: true},
		{name: "reversal", value: "DCBA-12", other: "21-ABCD", reversal: true},
		{name: "one character differs", value: "SYNTHETIC-002", other: "SYNTHETIC-001"},
		{name: "different length", value: "ABCD", other: "ABCDE"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shiftedByOne(tc.value, tc.other); got != tc.shifted {
				t.Errorf("shiftedByOne(%q, %q) = %v, want %v", tc.value, tc.other, got, tc.shifted)
			}

			if got := tc.value == reversed(tc.other); got != tc.reversal {
				t.Errorf("reversal(%q, %q) = %v, want %v", tc.value, tc.other, got, tc.reversal)
			}
		})
	}
}

// shiftedByOne reports whether other becomes value by moving letters and digits one step up or down; punctuation may
// stay as it is, because a transform that skips it is just as reversible.
func shiftedByOne(value, other string) bool {
	if len(value) != len(other) {
		return false
	}

	shifted := false

	for index := range len(value) {
		difference := int(value[index]) - int(other[index])

		switch {
		case difference == 1 || difference == -1:
			shifted = true
		case difference == 0 && !isAlphanumeric(value[index]):
		default:
			return false
		}
	}

	return shifted
}

func isAlphanumeric(character byte) bool {
	return character >= '0' && character <= '9' ||
		character >= 'a' && character <= 'z' ||
		character >= 'A' && character <= 'Z'
}

func reversed(value string) string {
	bytes := []byte(value)

	for left, right := 0, len(bytes)-1; left < right; left, right = left+1, right-1 {
		bytes[left], bytes[right] = bytes[right], bytes[left]
	}

	return string(bytes)
}

func TestVersionProbeUsesNoDeviceArguments(t *testing.T) {
	runner := &Runner{}
	got := runner.commandArgs(model.Command{Mode: "version"})
	want := []string{"--version"}

	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("version probe argv = %q, want %q", got, want)
	}
}

func sanitizedField(document map[string]json.RawMessage, name string) ([]byte, bool) {
	if name == "wwn.oui" || name == "wwn.id" {
		var wwn map[string]json.RawMessage

		if err := json.Unmarshal(document["wwn"], &wwn); err != nil {
			return nil, false
		}

		value, ok := wwn[name[len("wwn."):]]

		if !ok {
			return nil, false
		}

		return value, true
	}

	value, ok := document[name]

	if !ok {
		return nil, false
	}

	var text string

	if err := json.Unmarshal(value, &text); err != nil {
		return nil, false
	}

	return []byte(text), true
}
