package rcisession

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAuthModeDetectorClassifies(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   AuthMode
	}{
		{name: "unauthorized means token", status: http.StatusUnauthorized, body: ``, want: AuthModeToken},
		{name: "forbidden means token", status: http.StatusForbidden, body: ``, want: AuthModeToken},
		{name: "probe found means token", status: http.StatusOK, body: `{"probe":{"found":true}}`, want: AuthModeToken},
		{name: "probe absent means none", status: http.StatusOK, body: `{"probe":{"found":false}}`, want: AuthModeNone},
		{name: "missing probe means none", status: http.StatusOK, body: `{"result":[]}`, want: AuthModeNone},
		{name: "server error is unknown", status: http.StatusInternalServerError, body: `{}`, want: AuthModeUnknown},
		{name: "other status is unknown", status: http.StatusNotFound, body: `{}`, want: AuthModeUnknown},
		{name: "malformed body is unknown", status: http.StatusOK, body: `{`, want: AuthModeUnknown},
		{name: "array body is unknown", status: http.StatusOK, body: `[]`, want: AuthModeUnknown},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read probe body: %v", err)
				}

				if r.Method != http.MethodPost || r.URL.Path != "/rci/" {
					t.Errorf("probe request = %s %s", r.Method, r.URL.Path)
				}

				if r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
				}

				if r.Header.Get("X-Ndma-Tkn") != "" {
					t.Errorf("probe unexpectedly sent X-Ndma-Tkn")
				}

				if string(body) != `{"probe":"authentication token generate"}` {
					t.Errorf("probe body = %q", body)
				}

				w.WriteHeader(test.status)

				_, _ = io.WriteString(w, test.body)
			}))

			defer server.Close()

			detector := &AuthModeDetector{Client: server.Client(), BaseURL: server.URL, Timeout: time.Second}

			if got := detector.Detect(context.Background()); got != test.want {
				t.Fatalf("Detect() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestAuthModeDetectorCachesKnownMode(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"probe":{"found":false}}`)

			return
		}

		w.WriteHeader(http.StatusUnauthorized)
	}))

	defer server.Close()

	detector := &AuthModeDetector{Client: server.Client(), BaseURL: server.URL}

	for range 2 {
		if got := detector.Detect(context.Background()); got != AuthModeNone {
			t.Fatalf("Detect() = %q, want %q", got, AuthModeNone)
		}
	}

	if got := detector.Mode(); got != AuthModeNone {
		t.Fatalf("Mode() = %q, want %q", got, AuthModeNone)
	}

	if got := requests.Load(); got != 1 {
		t.Fatalf("probe requests = %d, want 1", got)
	}
}

func TestAuthModeDetectorDoesNotCacheUnknown(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}

		_, _ = io.WriteString(w, `{"probe":{"found":false}}`)
	}))

	defer server.Close()

	detector := &AuthModeDetector{Client: server.Client(), BaseURL: server.URL}

	if got := detector.Detect(context.Background()); got != AuthModeUnknown {
		t.Fatalf("first Detect() = %q, want %q", got, AuthModeUnknown)
	}

	if got := detector.Mode(); got != AuthModeUnknown {
		t.Fatalf("Mode() after failed probe = %q, want %q", got, AuthModeUnknown)
	}

	if got := detector.Detect(context.Background()); got != AuthModeNone {
		t.Fatalf("second Detect() = %q, want %q", got, AuthModeNone)
	}
}

func TestAuthModeDetectorModeDoesNoIO(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))

	defer server.Close()

	detector := &AuthModeDetector{Client: server.Client(), BaseURL: server.URL}

	if got := detector.Mode(); got != AuthModeUnknown {
		t.Fatalf("Mode() = %q, want %q", got, AuthModeUnknown)
	}

	if got := requests.Load(); got != 0 {
		t.Fatalf("probe requests = %d, want 0", got)
	}
}

func TestAuthModeDetectorUnknownForOversizedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"padding":"`+strings.Repeat("x", 64<<10)+`"}`)
	}))

	defer server.Close()

	detector := &AuthModeDetector{Client: server.Client(), BaseURL: server.URL}

	if got := detector.Detect(context.Background()); got != AuthModeUnknown {
		t.Fatalf("Detect() = %q, want %q", got, AuthModeUnknown)
	}
}
