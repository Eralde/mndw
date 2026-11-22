package deviceinfo

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}

	return data
}

func TestParseConstantsHopper(t *testing.T) {
	snapshot, err := parseConstants(readFixture(t, "ndmConstants-hopper.json"))
	if err != nil {
		t.Fatalf("parseConstants: %v", err)
	}

	if len(snapshot.Switchports.List) != 4 || snapshot.Switchports.List[0].ID != "WAN" || snapshot.Switchports.List[0].Label != "0" {
		t.Fatalf("switchport list = %+v, want Hopper Ethernet ports", snapshot.Switchports.List)
	}

	if snapshot.USBPortCount != 1 || !snapshot.Switchports.HasPortStats {
		t.Fatalf("device constants = %+v, want USB=1 and port stats enabled", snapshot)
	}

	for _, port := range snapshot.Switchports.List {
		if port.IsReversed || port.IsCombo || port.IsComboInverted {
			t.Fatalf("port %q without port orientation flags = %+v, want all false", port.ID, port)
		}
	}

	if !reflect.DeepEqual(snapshot.Switchports.Layout, [][]string{{"0", "1", "2", "3"}}) {
		t.Fatalf("layout = %v, want one Hopper row", snapshot.Switchports.Layout)
	}
}

func TestParseConstantsMultiRow(t *testing.T) {
	snapshot, err := parseConstants(readFixture(t, "ndmConstants-multi-row.json"))
	if err != nil {
		t.Fatalf("parseConstants: %v", err)
	}

	if len(snapshot.Switchports.List) != 4 {
		t.Fatalf("switchport list length = %d, want 4", len(snapshot.Switchports.List))
	}

	if !reflect.DeepEqual(snapshot.Switchports.Layout, [][]string{{"0", "1"}, {"2", "3"}}) {
		t.Fatalf("layout = %v, want two rows", snapshot.Switchports.Layout)
	}
}

func TestParseConstantsSinglePortDefaultsMissingSections(t *testing.T) {
	snapshot, err := parseConstants(readFixture(t, "ndmConstants-single-port.json"))
	if err != nil {
		t.Fatalf("parseConstants: %v", err)
	}

	if len(snapshot.Switchports.List) != 1 || snapshot.Switchports.List[0].ID != "LAN1" {
		t.Fatalf("switchport list = %+v, want one LAN1 port", snapshot.Switchports.List)
	}

	if snapshot.USBPortCount != 0 || snapshot.Switchports.HasPortStats {
		t.Fatalf("defaults = %+v, want zero/false values", snapshot)
	}

	if !reflect.DeepEqual(snapshot.Switchports.Layout, [][]string{}) {
		t.Fatalf("missing layout = %v, want empty array", snapshot.Switchports.Layout)
	}
}

func TestParseConstantsAppliesSkipCoerceAndDuplicateRules(t *testing.T) {
	snapshot, err := parseConstants(readFixture(t, "ndmConstants-malformed.json"))
	if err != nil {
		t.Fatalf("parseConstants: %v", err)
	}

	if len(snapshot.Switchports.List) != 3 {
		t.Fatalf("switchport list = %+v, want valid entries and duplicate winner", snapshot.Switchports.List)
	}

	if snapshot.Switchports.List[0].ID != "BAD_SPEED" || snapshot.Switchports.List[0].Index != 0 {
		t.Fatalf("first switchport = %+v, want BAD_SPEED index 0", snapshot.Switchports.List[0])
	}

	if snapshot.Switchports.List[1].ID != "ALPHA" || snapshot.Switchports.List[1].Index != 1 {
		t.Fatalf("second switchport = %+v, want ALPHA index 1", snapshot.Switchports.List[1])
	}

	if snapshot.Switchports.List[2].ID != "STRING_SPEED" || snapshot.Switchports.List[2].Index != 2 {
		t.Fatalf("third switchport = %+v, want STRING_SPEED index 2", snapshot.Switchports.List[2])
	}

	if snapshot.Switchports.List[1].Label != "ALPHA" {
		t.Fatalf("fallback label = %q, want map key", snapshot.Switchports.List[1].Label)
	}

	port := snapshot.Switchports.List[1]

	if port.IsReversed || port.IsCombo || port.IsComboInverted {
		t.Fatalf("non-boolean port orientation flags = %+v, want all false", port)
	}
}

func TestParseConstantsUsesNormalizedPortFieldsForDerivedData(t *testing.T) {
	snapshot, err := parseConstants(readFixture(t, "ndmConstants-derived-fields.json"))
	if err != nil {
		t.Fatalf("parseConstants: %v", err)
	}

	if snapshot.Switchports.List[0].ID != "WAN" || snapshot.Switchports.List[0].Group != "LAN" {
		t.Fatalf("WAN entry = %+v, want group LAN from PORTS_MAP", snapshot.Switchports.List[0])
	}

	if snapshot.Switchports.List[1].ID != "LAN1" || snapshot.Switchports.List[1].Group != "WAN" {
		t.Fatalf("LAN1 entry = %+v, want group WAN from PORTS_MAP", snapshot.Switchports.List[1])
	}

	if !reflect.DeepEqual(snapshot.Switchports.Layout, [][]string{{"0"}, {"1"}}) {
		t.Fatalf("layout = %v, want two rows from PORTS_LAYOUT", snapshot.Switchports.Layout)
	}

	if !snapshot.Switchports.List[0].IsReversed || snapshot.Switchports.List[1].IsReversed {
		t.Fatalf("switchport reversal flags = [%t, %t], want [true, false]", snapshot.Switchports.List[0].IsReversed, snapshot.Switchports.List[1].IsReversed)
	}

	if !snapshot.Switchports.List[0].IsCombo || snapshot.Switchports.List[0].IsComboInverted || snapshot.Switchports.List[1].IsCombo || !snapshot.Switchports.List[1].IsComboInverted {
		t.Fatalf("switchport combo flags = [%t/%t, %t/%t], want [true/false, false/true]", snapshot.Switchports.List[0].IsCombo, snapshot.Switchports.List[0].IsComboInverted, snapshot.Switchports.List[1].IsCombo, snapshot.Switchports.List[1].IsComboInverted)
	}
}

func TestParseConstantsRejectsInvalidJSONAndTrailingData(t *testing.T) {
	for name, data := range map[string][]byte{
		"invalid":  []byte(`{"PORTS_MAP":`),
		"trailing": append(readFixture(t, "ndmConstants-single-port.json"), []byte(` null`)...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseConstants(data); err == nil {
				t.Fatal("parseConstants returned nil error")
			}
		})
	}
}

func TestParseConstantsTreatsValidNonObjectAsEmpty(t *testing.T) {
	for _, data := range []string{"null", "[]", "true", "42", `"constants"`} {
		snapshot, err := parseConstants([]byte(data))
		if err != nil {
			t.Errorf("parseConstants(%s) error = %v, want nil", data, err)

			continue
		}

		if !reflect.DeepEqual(snapshot, emptySnapshot()) {
			t.Errorf("parseConstants(%s) = %+v, want empty snapshot", data, snapshot)
		}
	}
}
