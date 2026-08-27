package establisher

import (
	"context"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"

	"mndwd/internal/rcisession/enumeration"
)

func TestValidateAuthURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{name: "valid", url: "https://NODE.Keenetic.IO.:443/auth?x-ndma-tkn=one&url=/", want: true},
		{name: "wrong scheme", url: "http://node.keenetic.io/auth?x-ndma-tkn=one", want: false},
		{name: "wrong host", url: "https://other.keenetic.io/auth?x-ndma-tkn=one", want: false},
		{name: "userinfo", url: "https://user@node.keenetic.io/auth?x-ndma-tkn=one", want: false},
		{name: "fragment", url: "https://node.keenetic.io/auth?x-ndma-tkn=one#x", want: false},
		{name: "path", url: "https://node.keenetic.io/other?x-ndma-tkn=one", want: false},
		{name: "missing token", url: "https://node.keenetic.io/auth", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ValidateAuthURL(test.url, "node.keenetic.io")
			if (err == nil) != test.want {
				t.Fatalf("ValidateAuthURL() error = %v", err)
			}
		})
	}
}

func TestEstablishAcceptsDynamicHostCookieAndDisablesRedirects(t *testing.T) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	establisher := Establisher{
		AuthURLer: fakeAuthURLer{url: "https://node.keenetic.io/auth?x-ndma-tkn=one"},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/auth" {
				t.Fatalf("path = %q", request.URL.Path)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Set-Cookie": {"__Host-Http-dynamic=value; Path=/; Max-Age=299; Secure"}},
				Body:       io.NopCloser(strings.NewReader("ok")),
				Request:    request,
			}, nil
		})},
	}
	result, err := establisher.Establish(context.Background(), enumeration.Member{Identity: "node", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true})
	_ = jar
	if err != nil || result.Client == nil || result.Jar == nil || result.BaseURL != "https://node.keenetic.io" {
		t.Fatalf("Establish() = %#v, %v", result, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

type fakeAuthURLer struct {
	url string
}

func (f fakeAuthURLer) AuthURL(context.Context, string) (string, uint64, error) {
	return f.url, 1, nil
}
