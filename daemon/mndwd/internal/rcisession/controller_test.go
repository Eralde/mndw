package rcisession

import "testing"

func TestValidateControllerURLShape(t *testing.T) {
	valid := []string{
		"http://127.0.0.1:79",
		"http://192.168.1.1",
		"http://192.168.1.1:80",
		"https://controller.example",
		"http://127.0.0.1/",
	}

	for _, raw := range valid {
		if _, err := ValidateControllerURLShape(raw); err != nil {
			t.Errorf("ValidateControllerURLShape(%q) unexpected error: %v", raw, err)
		}
	}

	// The helper does not trim: whitespace-wrapped input must be rejected, so the
	// config flag path (which does not trim) keeps rejecting it.
	invalid := []string{
		"not-a-url",
		"ftp://192.168.1.1",
		"http://user:password@192.168.1.1",
		"http://192.168.1.1/rci",
		"http://192.168.1.1?token=secret",
		"http://192.168.1.1#frag",
		"http://",
		"",
		" http://127.0.0.1:79",
		"http://127.0.0.1:79 ",
	}

	for _, raw := range invalid {
		if _, err := ValidateControllerURLShape(raw); err == nil {
			t.Errorf("ValidateControllerURLShape(%q) expected error, got nil", raw)
		}
	}
}

func TestIsLoopbackHost(t *testing.T) {
	if !IsLoopbackHost("127.0.0.1") {
		t.Error("127.0.0.1 should be loopback")
	}

	if IsLoopbackHost("192.168.1.1") {
		t.Error("192.168.1.1 should not be loopback")
	}

	if IsLoopbackHost("controller.example") {
		t.Error("a hostname should not be loopback")
	}
}
