package rcisession

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestControllerHTTPTesterUsesPinnedRCIRequestAndMapsVerdicts(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		verdict ControllerVerdict
	}{
		{name: "valid", status: 200, verdict: ControllerValid},
		{name: "invalid", status: 401, verdict: ControllerInvalidToken},
		{name: "unsupported", status: 404, verdict: ControllerUnsupported},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := &controllerRoundTripper{response: &http.Response{StatusCode: test.status, Body: io.NopCloser(strings.NewReader("ok")), Header: make(http.Header)}}
			tester := ControllerHTTPTester{Client: &http.Client{Transport: transport}}
			verdict, err := tester.Test(context.Background(), "controller-token")
			if err != nil || verdict != test.verdict {
				t.Fatalf("Test() = %q, %v", verdict, err)
			}
			if transport.request.URL.String() != "http://127.0.0.1:79/rci/show/version" || transport.request.Header.Get("X-Ndma-Tkn") != "controller-token" {
				t.Fatalf("request = %s token=%q", transport.request.URL, transport.request.Header.Get("X-Ndma-Tkn"))
			}
		})
	}
}

func TestControllerHTTPTesterMapsNetworkFailureToUnreachable(t *testing.T) {
	tester := ControllerHTTPTester{Client: &http.Client{Transport: &controllerRoundTripper{err: io.ErrUnexpectedEOF}}}
	verdict, err := tester.Test(context.Background(), "controller-token")
	if verdict != ControllerUnreachable || err == nil {
		t.Fatalf("Test() = %q, %v", verdict, err)
	}
}

func TestControllerHTTPTesterUsesConfiguredBaseURL(t *testing.T) {
	transport := &controllerRoundTripper{response: &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), Header: make(http.Header)}}
	tester := ControllerHTTPTester{
		Client:  &http.Client{Transport: transport},
		BaseURL: "http://192.168.1.1:80",
	}

	if _, err := tester.Test(context.Background(), "controller-token"); err != nil {
		t.Fatal(err)
	}
	if transport.request.URL.String() != "http://192.168.1.1:80/rci/show/version" {
		t.Fatalf("request URL = %s", transport.request.URL)
	}
}

type controllerRoundTripper struct {
	request  *http.Request
	response *http.Response
	err      error
}

func (r *controllerRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	r.request = request
	return r.response, r.err
}
