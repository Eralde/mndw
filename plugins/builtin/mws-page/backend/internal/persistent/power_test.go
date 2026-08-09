package persistent

import (
	"encoding/json"
	"os"
	"testing"

	"mndw.local/rci"
)

func TestParseInterfacePowerUsesCapturedResponseShape(t *testing.T) {
	results := loadInterfacePowerFixture(t)

	first, err := rci.Extract(results[0], "show.sc.interface")
	if err != nil {
		t.Fatal(err)
	}

	second, err := rci.Extract(results[1], "show.sc.interface")
	if err != nil {
		t.Fatal(err)
	}

	firstPower, err := parseInterfacePower(first, "WifiMaster0")
	if err != nil {
		t.Fatal(err)
	}

	secondPower, err := parseInterfacePower(second, "WifiMaster1")
	if err != nil {
		t.Fatal(err)
	}

	assertPower(t, firstPower, 75, true)
	assertPower(t, secondPower, 100, true)
}

func TestParseInterfacePowerDefaultsInvalidPowerTo100(t *testing.T) {
	for _, raw := range []string{
		`{"WifiMaster0":{"power":""}}`,
		`{"WifiMaster0":{"power":"not-a-number"}}`,
		`{"WifiMaster0":{"power":"7.5"}}`,
		`{"WifiMaster0":{"power":-1}}`,
		`{"WifiMaster0":{"power":101}}`,
		`{"WifiMaster0":{"power":true}}`,
		`{"WifiMaster0":{}}`,
		`{}`,
	} {
		power, err := parseInterfacePower(json.RawMessage(raw), "WifiMaster0")
		if err != nil {
			t.Fatalf("parseInterfacePower(%s) error = %v", raw, err)
		}

		assertPower(t, power, 100, true)
	}
}

func TestParseInterfacePowerAcceptsNumericPower(t *testing.T) {
	power, err := parseInterfacePower(json.RawMessage(`{"WifiMaster0":{"power":42}}`), "WifiMaster0")
	if err != nil {
		t.Fatal(err)
	}

	assertPower(t, power, 42, true)
}

func TestParseInterfacePowerRejectsInvalidJSON(t *testing.T) {
	if _, err := parseInterfacePower(json.RawMessage(`{`), "WifiMaster0"); err == nil {
		t.Fatal("parseInterfacePower invalid JSON error = nil")
	}
}

func TestUnavailablePowerPreservesPreviousValue(t *testing.T) {
	previous := availablePower(75)
	power := unavailablePower(previous)

	assertPower(t, power, 75, false)
}

func loadInterfacePowerFixture(t *testing.T) []json.RawMessage {
	t.Helper()

	body, err := os.ReadFile("testdata/show-sc-interface.json")
	if err != nil {
		t.Fatal(err)
	}

	var results []json.RawMessage
	if err := json.Unmarshal(body, &results); err != nil {
		t.Fatal(err)
	}

	return results
}

func assertPower(t *testing.T, state PowerState, value int, available bool) {
	t.Helper()

	if state.Available != available {
		t.Fatalf("power availability = %v, want %v", state.Available, available)
	}

	if state.Value == nil || *state.Value != value {
		t.Fatalf("power value = %v, want %d", state.Value, value)
	}
}
