package persistent

import "testing"

func TestUnwrapStatusPreservesStepsAndHalfState(t *testing.T) {
	steps, err := UnwrapStatus([]byte(`[
		{"interface":{"power":{"status":[{"status":"message","code":"1","ident":"wifi","message":"set"}]}}},
		{"system":{"configuration":{"save":{"status":[{"status":"error","code":"2","ident":"save","message":"failed"}]}}}}
	]`), 2)
	if err != nil {
		t.Fatal(err)
	}

	if len(steps) != 2 || !steps[0].OK || steps[1].OK {
		t.Fatalf("steps = %#v", steps)
	}

	if len(steps[0].Status) != 1 || steps[0].Status[0].Message != "set" {
		t.Fatalf("set status = %#v", steps[0].Status)
	}

	if len(steps[1].Status) != 1 || steps[1].Status[0].Message != "failed" {
		t.Fatalf("save status = %#v", steps[1].Status)
	}
}

func TestUnwrapStatusUsesFixedFailedStepsForShapeErrors(t *testing.T) {
	for _, body := range []string{`[{"unexpected":true}]`, `[]`, `[1]`} {
		steps, err := UnwrapStatus([]byte(body), 2)
		if err != nil {
			t.Fatalf("UnwrapStatus(%s) error = %v", body, err)
		}

		if len(steps) != 2 || steps[0].OK || steps[1].OK {
			t.Fatalf("UnwrapStatus(%s) = %#v", body, steps)
		}
	}
}

func TestUnwrapStatusReturnsProtocolErrorsOnlyForInvalidJSONOrNonArray(t *testing.T) {
	for _, body := range []string{`{`, `null`, `"value"`} {
		if _, err := UnwrapStatus([]byte(body), 1); err == nil {
			t.Fatalf("UnwrapStatus(%s) error = nil", body)
		}
	}
}
