package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"mndwd/internal/rcisession/model"
)

func TestProxyInjectsTokenAndSupportsFutureMethods(t *testing.T) {
	transport := &fakeRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("ok")),
	}}
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Token: "secret-token", Support: model.SupportSupported, AllowInsecure: true}}
	proxy := New(resolver, &http.Client{Transport: transport}, 1024, 0)

	response, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "LINK", Path: "rci/show/version", Body: []byte(`{"x":1}`), AllowWrite: true})
	if err != nil {
		t.Fatal(err)
	}

	if response.Status != http.StatusOK || string(response.Body) != "ok" {
		t.Fatalf("response = %#v", response)
	}

	if transport.request.Method != "LINK" || transport.request.Header.Get("X-Ndma-Tkn") != "secret-token" {
		t.Fatalf("outbound request = %s token=%q", transport.request.Method, transport.request.Header.Get("X-Ndma-Tkn"))
	}
}

func TestProxyRejectsUnsafePathBeforeResolution(t *testing.T) {
	transport := &fakeRoundTripper{}
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Token: "secret-token", Support: model.SupportSupported, AllowInsecure: true}}
	proxy := New(resolver, &http.Client{Transport: transport}, 1024, 0)

	for _, path := range []string{"/rci/show/version", "http://evil/rci", "rci/../secret", "rci/show?x=1"} {
		if _, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "GET", Path: path}); err == nil {
			t.Fatalf("path %q accepted", path)
		}
	}

	if resolver.calls != 0 || transport.request != nil {
		t.Fatalf("unsafe path reached resolver/transport: calls=%d request=%v", resolver.calls, transport.request)
	}
}

func TestProxyRejectsWriteWithoutWriteGrantBeforeResolution(t *testing.T) {
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Token: "secret-token", Support: model.SupportSupported, AllowInsecure: true}}
	proxy := New(resolver, &http.Client{Transport: &fakeRoundTripper{}}, 1024, 0)

	_, err := proxy.Do(context.Background(), Request{
		Target: "node-1", Method: "POST", Path: "rci/",
		Body: []byte(`[{"interface":{"name":"WifiMaster0","power":75}}]`),
	})
	if !errors.Is(err, ErrWriteNotPermitted) {
		t.Fatalf("error = %v, want write-not-permitted", err)
	}

	if resolver.calls != 0 {
		t.Fatalf("resolver calls = %d, want zero", resolver.calls)
	}
}

func TestProxyMapsUnauthorizedAndNotifiesResolver(t *testing.T) {
	transport := &fakeRoundTripper{response: &http.Response{
		StatusCode: http.StatusUnauthorized,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("no")),
	}}
	resolver := &fakeResolver{destination: Destination{BaseURL: "https://node.keenetic.io", Client: &http.Client{Transport: transport}, Support: model.SupportSupported}}
	proxy := New(resolver, &http.Client{Transport: transport}, 1024, 0)

	_, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "GET", Path: "rci/show/version"})
	if !errors.Is(err, ErrSessionInvalid) || !resolver.unauthorized {
		t.Fatalf("error = %v, unauthorized = %v", err, resolver.unauthorized)
	}
}

func TestProxyBoundsResponseBody(t *testing.T) {
	transport := &fakeRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("too long")),
	}}
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Token: "secret-token", Support: model.SupportSupported, AllowInsecure: true}}
	proxy := New(resolver, &http.Client{Transport: transport}, 3, 0)

	if _, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "GET", Path: "rci/show/version"}); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("error = %v, want response-too-large", err)
	}
}

func TestProxyRejectsInsecureTokenDestinationWithoutOutboundRequest(t *testing.T) {
	transport := &fakeRoundTripper{}
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Token: "secret-token", Support: model.SupportSupported}}
	proxy := New(resolver, &http.Client{Transport: transport}, 1024, 0)

	_, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "GET", Path: "rci/show/version"})
	if !errors.Is(err, ErrSecureEndpointUnavailable) {
		t.Fatalf("error = %v, want secure endpoint unavailable", err)
	}

	if transport.request != nil {
		t.Fatalf("insecure destination made outbound request: %#v", transport.request)
	}
}

func TestProxyControllerWithoutToken(t *testing.T) {
	transport := &fakeRoundTripper{response: &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("ok")),
	}}
	resolver := &fakeResolver{destination: Destination{Controller: true, BaseURL: "http://192.168.1.2", Support: model.SupportSupported, AllowInsecure: true}}
	proxy := New(resolver, &http.Client{Transport: transport}, 1024, 0)

	if _, err := proxy.Do(context.Background(), Request{Target: "controller", Method: "GET", Path: "rci/show/version"}); err != nil {
		t.Fatal(err)
	}

	if transport.request == nil || transport.request.Header.Get("X-Ndma-Tkn") != "" {
		t.Fatalf("tokenless controller request = %#v", transport.request)
	}
}

func TestProxyRejectsMissingOrUnsupportedSession(t *testing.T) {
	for _, support := range []model.Support{"", model.SupportUnsupported} {
		resolver := &fakeResolver{destination: Destination{Support: support}}
		proxy := New(resolver, &http.Client{Transport: &fakeRoundTripper{}}, 1024, 0)
		_, err := proxy.Do(context.Background(), Request{Target: "node-1", Method: "GET", Path: "rci/show/version"})

		if support == model.SupportUnsupported {
			if !errors.Is(err, ErrUnsupported) {
				t.Fatalf("support=%q error=%v, want unsupported", support, err)
			}
		} else if !errors.Is(err, ErrNoSession) {
			t.Fatalf("support=%q error=%v, want no-session", support, err)
		}
	}
}

type fakeResolver struct {
	destination  Destination
	calls        int
	unauthorized bool
	generation   uint64
	epoch        uint64
}

func (f *fakeResolver) Resolve(context.Context, string) (Destination, error) {
	f.calls++

	return f.destination, nil
}

func (f *fakeResolver) InvalidateController(epoch uint64) { f.epoch = epoch }

func (f *fakeResolver) Unauthorized(_ string, generation uint64) {
	f.unauthorized = true
	f.generation = generation
}

type fakeRoundTripper struct {
	request  *http.Request
	response *http.Response
}

func (f *fakeRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	f.request = request

	return f.response, nil
}
