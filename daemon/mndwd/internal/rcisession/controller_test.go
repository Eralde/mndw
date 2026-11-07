package rcisession

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestControllerHTTPTesterEmptyTokenOmitsHeader(t *testing.T) {
	tester := ControllerHTTPTester{
		BaseURL: "http://192.0.2.1",
		Client: &http.Client{Transport: testRoundTripper(func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("X-Ndma-Tkn") != "" {
				t.Fatalf("empty token sent header %q", request.Header.Get("X-Ndma-Tkn"))
			}

			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ok"))}, nil
		})},
	}
	verdict, err := tester.Test(context.Background(), "")
	if err != nil || verdict != ControllerValid {
		t.Fatalf("Test() = %q, %v", verdict, err)
	}
}

func TestControllerHTTPTesterPreservesTransportError(t *testing.T) {
	cause := errors.New("connection refused")
	tester := ControllerHTTPTester{
		BaseURL: "http://192.0.2.1:79",
		Client: &http.Client{Transport: testRoundTripper(func(*http.Request) (*http.Response, error) {
			return nil, cause
		})},
	}

	verdict, err := tester.Test(context.Background(), "controller-secret")
	if verdict != ControllerUnreachable || !errors.Is(err, cause) {
		t.Fatalf("Test() = %q, %v; want unreachable wrapping cause", verdict, err)
	}
}

func TestControllerHTTPTesterStatusClassification(t *testing.T) {
	tests := []struct {
		status      int
		wantVerdict ControllerVerdict
		wantError   string
	}{
		{status: http.StatusOK, wantVerdict: ControllerValid},
		{status: http.StatusUnauthorized, wantVerdict: ControllerInvalidToken},
		{status: http.StatusForbidden, wantVerdict: ControllerInvalidToken},
		{status: http.StatusNotFound, wantVerdict: ControllerUnsupported},
		{status: http.StatusMethodNotAllowed, wantVerdict: ControllerUnsupported},
		{status: http.StatusNotImplemented, wantVerdict: ControllerUnsupported},
		{status: http.StatusBadRequest, wantVerdict: ControllerUnreachable, wantError: "400"},
		{status: http.StatusRequestTimeout, wantVerdict: ControllerUnreachable, wantError: "408"},
		{status: http.StatusTooManyRequests, wantVerdict: ControllerUnreachable, wantError: "429"},
		{status: http.StatusBadGateway, wantVerdict: ControllerUnreachable, wantError: "502"},
	}

	for _, test := range tests {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			tester := ControllerHTTPTester{
				BaseURL: "http://192.0.2.1:79",
				Client: &http.Client{Transport: testRoundTripper(func(*http.Request) (*http.Response, error) {
					return &http.Response{
						StatusCode: test.status,
						Header:     make(http.Header),
						Body:       io.NopCloser(strings.NewReader("")),
					}, nil
				})},
			}

			verdict, err := tester.Test(context.Background(), "controller-secret")
			if verdict != test.wantVerdict {
				t.Fatalf("verdict = %q, want %q (err=%v)", verdict, test.wantVerdict, err)
			}

			if test.wantError == "" {
				if err != nil {
					t.Fatalf("error = %v, want nil", err)
				}

				return
			}

			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error = %v, want status code %s", err, test.wantError)
			}
		})
	}
}

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
