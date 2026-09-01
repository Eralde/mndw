package deviceinfo

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newIPv4Server(handler http.Handler) *httptest.Server {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}

	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener

	server.Start()

	return server
}

func TestHTTPFetcherGetsConstantsAndNormalizesResponse(t *testing.T) {
	server := newIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/device/ndmConstants.json" {
			t.Fatalf("request = %s %s, want GET /device/ndmConstants.json", request.Method, request.URL.Path)
		}

		_, _ = io.WriteString(writer, `{"USB_PORTS_NUMBER":2,"PORTS_MAP":{"WAN":{"index":0,"name":"0","maxSpeed":1000}}}`)
	}))

	defer server.Close()

	fetcher, err := NewHTTPFetcher(server.URL+"/device/", nil, FetcherOptions{Client: server.Client()})
	if err != nil {
		t.Fatalf("NewHTTPFetcher: %v", err)
	}

	snapshot, err := fetcher.Fetch(context.Background(), "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	if len(snapshot.Switchports.List) != 1 || snapshot.Switchports.List[0].ID != "WAN" {
		t.Fatalf("switchports = %+v, want normalized WAN port", snapshot)
	}

	if snapshot.USBPortCount != 2 {
		t.Fatalf("USB port count = %d, want 2", snapshot.USBPortCount)
	}
}

func TestHTTPFetcherReturnsErrorsForBadUpstreamResponses(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
	}{
		"non-2xx":      {status: http.StatusServiceUnavailable, body: "unavailable"},
		"invalid JSON": {status: http.StatusOK, body: "{"},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			server := newIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(tc.status)

				_, _ = io.WriteString(writer, tc.body)
			}))

			defer server.Close()

			fetcher, err := NewHTTPFetcher(server.URL, slog.Default(), FetcherOptions{Client: server.Client()})
			if err != nil {
				t.Fatalf("NewHTTPFetcher: %v", err)
			}

			if _, err := fetcher.Fetch(context.Background(), ""); err == nil {
				t.Fatal("Fetch returned nil error")
			}
		})
	}
}

func TestHTTPFetcherRejectsBodyLargerThanLimit(t *testing.T) {
	server := newIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, `{"PORTS_MAP":{}}`+strings.Repeat("x", maxConstantsBytes))
	}))

	defer server.Close()

	fetcher, err := NewHTTPFetcher(server.URL, nil, FetcherOptions{Client: server.Client()})
	if err != nil {
		t.Fatalf("NewHTTPFetcher: %v", err)
	}

	if _, err := fetcher.Fetch(context.Background(), ""); err == nil {
		t.Fatal("Fetch accepted oversized body")
	}
}

func TestHTTPFetcherUsesClientTimeout(t *testing.T) {
	started := make(chan struct{})
	server := newIPv4Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))

	defer server.Close()

	client := server.Client()
	client.Timeout = 10 * time.Millisecond
	fetcher, err := NewHTTPFetcher(server.URL, nil, FetcherOptions{Client: client})
	if err != nil {
		t.Fatalf("NewHTTPFetcher: %v", err)
	}

	if _, err := fetcher.Fetch(context.Background(), ""); err == nil {
		t.Fatal("Fetch returned nil timeout error")
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream request did not start")
	}
}
