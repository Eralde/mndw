package deviceproxy

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func newIPv4Server(handler http.Handler) *httptest.Server {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}

	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}

	server.Start()

	return server
}

func TestProxyRewritesHostAndPreservesPath(t *testing.T) {
	var gotHost, gotPath string
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotPath = r.URL.Path

		w.WriteHeader(http.StatusOK)
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/rci/show/system", nil)
	req.Host = "dashboard.lan"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	deviceHost := strings.TrimPrefix(device.URL, "http://")

	if gotHost != deviceHost {
		t.Fatalf("upstream Host = %q, want %q", gotHost, deviceHost)
	}

	if gotPath != "/rci/show/system" {
		t.Fatalf("upstream path = %q, want /rci/show/system", gotPath)
	}
}

func TestProxyRewritesLocationBackToIncomingHost(t *testing.T) {
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://"+r.Host+"/auth/login")
		w.WriteHeader(http.StatusFound)
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth", nil)
	req.Host = "dashboard.lan"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	loc := rec.Header().Get("Location")

	if !strings.Contains(loc, "dashboard.lan") {
		t.Fatalf("Location not rewritten to incoming host: %q", loc)
	}

	deviceHost := strings.TrimPrefix(device.URL, "http://")

	if strings.Contains(loc, deviceHost) {
		t.Fatalf("Location still names device host: %q", loc)
	}
}

func TestProxyRewritesOnlyLocationAuthority(t *testing.T) {
	var deviceHost string
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://"+deviceHost+"/redirect?next=http://"+deviceHost+"/x")
		w.WriteHeader(http.StatusFound)
	}))

	defer device.Close()

	deviceHost = strings.TrimPrefix(device.URL, "http://")

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth", nil)
	req.Host = "dashboard.lan"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	loc := rec.Header().Get("Location")

	if !strings.HasPrefix(loc, "http://dashboard.lan/redirect") {
		t.Fatalf("authority not rewritten: %q", loc)
	}

	if !strings.Contains(loc, "next=http://"+deviceHost+"/x") {
		t.Fatalf("query text was mangled: %q", loc)
	}
}

func TestSameDeviceHostAllowsExplicitDefaultPort(t *testing.T) {
	target, _ := url.Parse("http://192.168.1.1")
	location, _ := url.Parse("http://192.168.1.1:80/auth")

	if !sameDeviceHost(location, target) {
		t.Fatal("device host with explicit default port did not match target host")
	}
}

// upstreamOrigin sends one POST through the proxy and returns the Origin values the device saw.
func upstreamOrigin(t *testing.T, incomingHost, origin string) (*httptest.Server, []string) {
	t.Helper()

	var got []string
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Values("Origin")

		w.WriteHeader(http.StatusUnauthorized)
	}))

	t.Cleanup(device.Close)

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/auth", strings.NewReader(`{"login":"admin"}`))
	req.Host = incomingHost

	if origin != "" {
		req.Header.Set("Origin", origin)
	}

	h.ServeHTTP(httptest.NewRecorder(), req)

	return device, got
}

func TestProxyRewritesDashboardOriginToDeviceOrigin(t *testing.T) {
	device, got := upstreamOrigin(t, "192.168.1.1:99", "http://192.168.1.1:99")

	if len(got) != 1 || got[0] != device.URL {
		t.Fatalf("upstream Origin = %q, want [%q]", got, device.URL)
	}
}

func TestProxyKeepsCrossSiteOrigin(t *testing.T) {
	_, got := upstreamOrigin(t, "192.168.1.1:99", "http://evil.example")

	if len(got) != 1 || got[0] != "http://evil.example" {
		t.Fatalf("upstream Origin = %q, want [\"http://evil.example\"]", got)
	}
}

func TestProxyDoesNotAddOrigin(t *testing.T) {
	_, got := upstreamOrigin(t, "192.168.1.1:99", "")

	if len(got) != 0 {
		t.Fatalf("upstream Origin = %q, want none", got)
	}
}

func TestDeviceOriginOmitsDefaultPort(t *testing.T) {
	for raw, want := range map[string]string{
		"http://192.168.1.1:80":    "http://192.168.1.1",
		"https://router.lan:443/x": "https://router.lan",
		"http://192.168.1.1:8080":  "http://192.168.1.1:8080",
		"HTTP://Router.LAN":        "http://router.lan",
	} {
		target, _ := url.Parse(raw)

		if got := deviceOrigin(target); got != want {
			t.Errorf("deviceOrigin(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestProxyDoesNotRewriteSetCookie(t *testing.T) {
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Set-Cookie", "sid=x; Domain="+r.Host)
		w.WriteHeader(http.StatusOK)
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/rci", nil)
	req.Host = "dashboard.lan"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	deviceHost := strings.TrimPrefix(device.URL, "http://")

	if !strings.Contains(rec.Header().Get("Set-Cookie"), deviceHost) {
		t.Fatalf("Set-Cookie was rewritten: %q", rec.Header().Get("Set-Cookie"))
	}
}

func TestProxyDoesNotLeakInternalHeaderUpstream(t *testing.T) {
	var headers http.Header
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/rci", nil)
	req.Host = "dashboard.lan"

	h.ServeHTTP(httptest.NewRecorder(), req)

	for key := range headers {
		if strings.HasPrefix(strings.ToLower(key), "x-mndw") {
			t.Fatalf("internal header leaked upstream: %q", key)
		}
	}
}

func TestProxyPropagatesUpstreamBody(t *testing.T) {
	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "device-body")
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/ci/foo", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Body.String() != "device-body" {
		t.Fatalf("body = %q, want device-body", rec.Body.String())
	}
}

func TestNewRejectsBadDeviceURL(t *testing.T) {
	if _, err := New("://not a url", slog.Default()); err == nil {
		t.Fatal("expected error for bad device URL")
	}
}

func TestProxyStreamsBeforeUpstreamFinishes(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseUpstream := func() { releaseOnce.Do(func() { close(release) }) }

	defer releaseUpstream()

	device := newIPv4Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)

		if !ok {
			t.Error("device ResponseWriter is not a Flusher")

			return
		}

		_, _ = io.WriteString(w, "first\n")

		flusher.Flush()
		<-release

		_, _ = io.WriteString(w, "second\n")
	}))

	defer device.Close()

	h, err := New(device.URL, slog.Default())
	if err != nil {
		t.Fatal(err)
	}

	server := newIPv4Server(h)

	defer server.Close()

	resp, err := http.Get(server.URL + "/rci/longpoll")
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	buf := make([]byte, len("first\n"))

	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("read first chunk: %v", err)
	}

	if string(buf) != "first\n" {
		t.Fatalf("first chunk = %q, want first\\n", buf)
	}

	releaseUpstream()

	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}

	if string(rest) != "second\n" {
		t.Fatalf("rest = %q, want second\\n", rest)
	}
}
