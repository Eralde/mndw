package rci

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type closeRecordingBody struct {
	reader    io.Reader
	readBytes int
	closes    int
}

func (body *closeRecordingBody) Read(p []byte) (int, error) {
	read, err := body.reader.Read(p)
	body.readBytes += read

	return read, err
}

func (body *closeRecordingBody) Close() error {
	body.closes++

	return nil
}

func newHTTPTransportWithBody(t *testing.T, status int, body io.ReadCloser, opts ...HTTPOption) Transport {
	t.Helper()

	client := &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: status,
			Body:       body,
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}
	options := make([]HTTPOption, 0, len(opts)+1)
	options = append(options, WithHTTPClient(client))
	options = append(options, opts...)
	transport, err := NewHTTPTransport("http://host", options...)
	if err != nil {
		t.Fatal(err)
	}

	return transport
}

func TestHTTPURLNormalization(t *testing.T) {
	tests := []struct {
		base string
		want string
	}{
		{base: "http://host", want: "http://host/rci/"},
		{base: "http://host/", want: "http://host/rci/"},
		{base: "http://host/base", want: "http://host/base/rci/"},
		{base: "http://host/base/", want: "http://host/base/rci/"},
		{base: "http://host/a%2Fb", want: "http://host/a%2Fb/rci/"},
	}

	for _, test := range tests {
		t.Run(test.base, func(t *testing.T) {
			transport, err := NewHTTPTransport(test.base)
			if err != nil {
				t.Fatal(err)
			}

			httpTransport := transport.(*httpTransport)

			if got := httpTransport.endpoint.String(); got != test.want {
				t.Fatalf("endpoint = %s, want %s", got, test.want)
			}
		})
	}
}

func TestHTTPRejectsInvalidBaseURLs(t *testing.T) {
	for _, base := range []string{
		"",
		"://bad",
		"ftp://host",
		"http:///path",
		"http://:80",
		"http://user:pass@host",
		"http://host?query=1",
		"http://host#fragment",
		"http://host/a/./b",
		"http://host/a/../b",
		"http://host/%2e/",
		"http://host/%2e%2e/",
		"http://host/a/%2E%2E/b",
	} {
		t.Run(base, func(t *testing.T) {
			_, err := NewHTTPTransport(base)
			if !errors.Is(err, ErrInvalidBaseURL) {
				t.Fatalf("NewHTTPTransport(%q) = %v, want ErrInvalidBaseURL", base, err)
			}
		})
	}
}

func TestHTTPRequestConstructionAndPerRequestHeaders(t *testing.T) {
	var headerCalls int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}

		if request.Method != http.MethodPost || request.URL.Path != "/rci/" || string(body) != `[{"show":{}}]` {
			t.Errorf("request = %s %s body %s, want POST /rci/ [{\"show\":{}}]", request.Method, request.URL.Path, body)
		}

		if request.Header.Get("Accept") != "application/json" {
			t.Errorf("Accept = %q, want application/json", request.Header.Get("Accept"))
		}

		if request.Header.Get("Content-Type") != "text/custom" {
			t.Errorf("Content-Type = %q, want custom override", request.Header.Get("Content-Type"))
		}

		if got, want := request.Header.Get("X-Ndma-Tkn"), "token-"+string(rune('0'+headerCalls)); got != want {
			t.Errorf("X-Ndma-Tkn = %q, want %q", got, want)
		}

		response.WriteHeader(http.StatusOK)

		_, _ = response.Write([]byte(`[]`))
	}))

	defer server.Close()

	transport, err := NewHTTPTransport(server.URL,
		WithHeader("X-Ndma-Tkn", func() string {
			headerCalls++

			return "token-" + string(rune('0'+headerCalls))
		}),
		WithHeader("Content-Type", func() string { return "text/custom" }),
	)
	if err != nil {
		t.Fatal(err)
	}

	for range 2 {
		response, err := transport.Send(context.Background(), []byte(`[{"show":{}}]`))
		if err != nil || response.Status != http.StatusOK || string(response.Body) != `[]` {
			t.Fatalf("Send() = (%#v, %v), want 200 and []", response, err)
		}
	}

	if headerCalls != 2 {
		t.Fatalf("header callback calls = %d, want 2", headerCalls)
	}
}

func TestHTTPWithNilClientReturnsSentinel(t *testing.T) {
	_, err := NewHTTPTransport("http://host", WithHTTPClient(nil))
	if !errors.Is(err, ErrNilHTTPClient) {
		t.Fatalf("NewHTTPTransport with nil client = %v, want ErrNilHTTPClient", err)
	}
}

func TestHTTPUsesFreshDefaultClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`[]`))
	}))

	defer server.Close()

	oldTransport := http.DefaultClient.Transport
	http.DefaultClient.Transport = roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("global default client used")
	})

	defer func() { http.DefaultClient.Transport = oldTransport }()

	transport, err := NewHTTPTransport(server.URL)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := transport.Send(context.Background(), []byte(`[]`)); err != nil {
		t.Fatalf("Send() = %v, want fresh default client to reach server", err)
	}
}

func TestHTTPUsesCustomClient(t *testing.T) {
	var called bool
	client := &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		called = true

		if request.URL.String() != "http://host/rci/" {
			return nil, errors.New("unexpected request URL: " + request.URL.String())
		}

		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(bytes.NewReader([]byte(`[]`))),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}
	transport, err := NewHTTPTransport("http://host", WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := transport.Send(context.Background(), []byte(`[]`)); err != nil {
		t.Fatal(err)
	}

	if !called {
		t.Fatal("custom client RoundTripper was not called")
	}
}

func TestHTTPRequestBodyIsNotModified(t *testing.T) {
	want := []byte(`[{"show":{}}]`)
	got := append([]byte(nil), want...)
	client := &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(request.Body)

		if !bytes.Equal(body, want) {
			return nil, errors.New("request body changed")
		}

		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`[]`)), Header: make(http.Header), Request: request}, nil
	})}
	transport, err := NewHTTPTransport("http://host", WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := transport.Send(context.Background(), got); err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, want) {
		t.Fatalf("body after Send = %s, want %s", got, want)
	}
}

func TestHTTPResponseBodyClosesOnSuccess(t *testing.T) {
	body := &closeRecordingBody{reader: strings.NewReader(`[]`)}
	transport := newHTTPTransportWithBody(t, http.StatusOK, body)

	response, err := transport.Send(context.Background(), []byte(`[]`))
	if err != nil || response.Status != http.StatusOK || string(response.Body) != `[]` {
		t.Fatalf("Send() = (%#v, %v), want 200 and []", response, err)
	}

	if body.closes != 1 {
		t.Fatalf("body closes = %d, want 1", body.closes)
	}
}

func TestHTTPResponseBodyClosesOnNon200(t *testing.T) {
	body := &closeRecordingBody{reader: strings.NewReader(strings.Repeat("x", 8<<10))}
	transport := newHTTPTransportWithBody(t, http.StatusBadGateway, body)

	response, err := transport.Send(context.Background(), []byte(`[]`))
	if err != nil {
		t.Fatal(err)
	}

	if response.Status != http.StatusBadGateway || len(response.Body) != 4<<10 {
		t.Fatalf("response = (%d, %d bytes), want 502 and 4096 bytes", response.Status, len(response.Body))
	}

	if body.readBytes > 4<<10 {
		t.Fatalf("body read %d bytes, want at most 4096", body.readBytes)
	}

	if body.closes != 1 {
		t.Fatalf("body closes = %d, want 1", body.closes)
	}
}

func TestHTTPResponseBodyClosesOnReadError(t *testing.T) {
	wantErr := errors.New("read failed")
	body := &closeRecordingBody{reader: failingReader{err: wantErr}}
	transport := newHTTPTransportWithBody(t, http.StatusOK, body)

	_, err := transport.Send(context.Background(), []byte(`[]`))
	if !errors.Is(err, wantErr) {
		t.Fatalf("Send() error = %v, want %v", err, wantErr)
	}

	if body.closes != 1 {
		t.Fatalf("body closes = %d, want 1", body.closes)
	}
}

func TestHTTPDefaultResponseLimit(t *testing.T) {
	exactBody := &closeRecordingBody{reader: bytes.NewReader(bytes.Repeat([]byte("x"), 16<<20))}
	exactTransport := newHTTPTransportWithBody(t, http.StatusOK, exactBody)
	response, err := exactTransport.Send(context.Background(), []byte(`[]`))
	if err != nil {
		t.Fatalf("exact-limit Send() error = %v", err)
	}

	if len(response.Body) != 16<<20 {
		t.Fatalf("exact-limit body length = %d, want %d", len(response.Body), 16<<20)
	}

	if exactBody.closes != 1 {
		t.Fatalf("exact-limit body closes = %d, want 1", exactBody.closes)
	}

	oversizeBody := &closeRecordingBody{reader: bytes.NewReader(bytes.Repeat([]byte("x"), (16<<20)+1))}
	oversizeTransport := newHTTPTransportWithBody(t, http.StatusOK, oversizeBody)
	_, err = oversizeTransport.Send(context.Background(), []byte(`[]`))
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("oversize Send() error = %v, want ErrResponseTooLarge", err)
	}

	if oversizeBody.closes != 1 {
		t.Fatalf("oversize body closes = %d, want 1", oversizeBody.closes)
	}
}

func TestHTTPCustomResponseLimits(t *testing.T) {
	boundaryBody := &closeRecordingBody{reader: strings.NewReader("1234")}
	boundaryTransport := newHTTPTransportWithBody(t, http.StatusOK, boundaryBody, WithMaxResponseBytes(4))
	response, err := boundaryTransport.Send(context.Background(), []byte(`[]`))
	if err != nil || string(response.Body) != "1234" {
		t.Fatalf("boundary Send() = (%q, %v), want 1234 and no error", response.Body, err)
	}

	oversizeBody := &closeRecordingBody{reader: strings.NewReader("12345")}
	oversizeTransport := newHTTPTransportWithBody(t, http.StatusOK, oversizeBody, WithMaxResponseBytes(4))
	_, err = oversizeTransport.Send(context.Background(), []byte(`[]`))
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("custom oversize Send() error = %v, want ErrResponseTooLarge", err)
	}

	unlimitedBody := &closeRecordingBody{reader: strings.NewReader("12345")}
	unlimitedTransport := newHTTPTransportWithBody(t, http.StatusOK, unlimitedBody, WithMaxResponseBytes(0))
	response, err = unlimitedTransport.Send(context.Background(), []byte(`[]`))
	if err != nil || string(response.Body) != "12345" {
		t.Fatalf("unlimited Send() = (%q, %v), want 12345 and no error", response.Body, err)
	}
}

func TestHTTPMaxInt64ResponseLimit(t *testing.T) {
	body := &closeRecordingBody{reader: strings.NewReader(`[]`)}
	transport := newHTTPTransportWithBody(t, http.StatusOK, body, WithMaxResponseBytes(math.MaxInt64))

	response, err := transport.Send(context.Background(), []byte(`[]`))
	if err != nil || string(response.Body) != `[]` {
		t.Fatalf("Send() = (%q, %v), want [] and no error", response.Body, err)
	}
}

func TestHTTPMalformedResponseClosesBody(t *testing.T) {
	body := &closeRecordingBody{reader: strings.NewReader(`{`)}
	transport := newHTTPTransportWithBody(t, http.StatusOK, body)
	client, err := New(transport)
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.Execute(context.Background(), Q("show"))
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("Execute() error = %v, want ErrInvalidResponse", err)
	}

	if body.closes != 1 {
		t.Fatalf("body closes = %d, want 1", body.closes)
	}
}

type failingReader struct {
	err error
}

func (reader failingReader) Read([]byte) (int, error) {
	return 0, reader.err
}

func TestHTTPRedirectProtection(t *testing.T) {
	var secondRequests int
	second := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		secondRequests++

		response.WriteHeader(http.StatusOK)
	}))

	defer second.Close()

	var tokenCalls int
	first := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if got, want := request.Header.Get("X-Ndma-Tkn"), "secret"; got != want {
			t.Errorf("X-Ndma-Tkn = %q, want %q", got, want)
		}

		response.Header().Set("Location", second.URL)
		response.WriteHeader(http.StatusFound)
	}))

	defer first.Close()

	originalErr := errors.New("original redirect policy")
	caller := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return originalErr
	}}
	transport, err := NewHTTPTransport(first.URL,
		WithHTTPClient(caller),
		WithHeader("X-Ndma-Tkn", func() string {
			tokenCalls++

			return "secret"
		}),
	)
	if err != nil {
		t.Fatal(err)
	}

	response, err := transport.Send(context.Background(), []byte(`[]`))
	if err != nil {
		t.Fatalf("Send() error = %v, want nil", err)
	}

	if response.Status != http.StatusFound {
		t.Fatalf("response status = %d, want %d", response.Status, http.StatusFound)
	}

	if secondRequests != 0 {
		t.Fatalf("redirect target requests = %d, want 0", secondRequests)
	}

	if tokenCalls != 1 {
		t.Fatalf("token callback calls = %d, want 1", tokenCalls)
	}

	if got := caller.CheckRedirect(nil, nil); !errors.Is(got, originalErr) {
		t.Fatalf("caller CheckRedirect() = %v, want original error", got)
	}
}
