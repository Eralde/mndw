package authz

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRouter accepts the cookie "session=valid" and rejects everything else,
// counting how many times it is hit so cache behavior can be asserted.
func fakeRouter(t *testing.T) (*httptest.Server, *int64) {
	t.Helper()
	var calls int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)
		if r.URL.Path != "/auth" {
			t.Errorf("router path = %q, want /auth", r.URL.Path)
		}
		if r.Header.Get("Cookie") == "session=valid" {
			w.WriteHeader(http.StatusOK)

			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	return srv, &calls
}

func req(cookie string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/mgmt/list", nil)
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}

	return r
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestAuthenticateValidCookieIsCached(t *testing.T) {
	router, calls := fakeRouter(t)
	v := New(router.URL, false, discardLogger(), Options{})

	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("first authenticate = %v, want nil", err)
	}
	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("second authenticate = %v, want nil", err)
	}
	if got := atomic.LoadInt64(calls); got != 1 {
		t.Errorf("router hit %d times, want 1 (second should be cached)", got)
	}
}

func TestAuthenticateInvalidCookieRejected(t *testing.T) {
	router, _ := fakeRouter(t)
	v := New(router.URL, false, discardLogger(), Options{})

	err := v.Authenticate(req("session=nope"))
	if err == nil {
		t.Fatalf("expected rejection for invalid cookie")
	}
	if err.Status != http.StatusUnauthorized || err.Code != "UNAUTHORIZED" {
		t.Errorf("got status=%d code=%s, want 401/UNAUTHORIZED", err.Status, err.Code)
	}
}

func TestAuthenticateNoCookieShortCircuits(t *testing.T) {
	router, calls := fakeRouter(t)
	v := New(router.URL, false, discardLogger(), Options{})

	if err := v.Authenticate(req("")); err == nil {
		t.Fatalf("expected rejection with no cookie")
	}
	if got := atomic.LoadInt64(calls); got != 0 {
		t.Errorf("router hit %d times, want 0 (no cookie should not call router)", got)
	}
}

func TestDevModeBypassesRouter(t *testing.T) {
	router, calls := fakeRouter(t)
	v := New(router.URL, true, discardLogger(), Options{})

	if err := v.Authenticate(req("")); err != nil {
		t.Fatalf("dev mode should accept everything, got %v", err)
	}
	if got := atomic.LoadInt64(calls); got != 0 {
		t.Errorf("dev mode should never contact the router, hit %d times", got)
	}
}

func TestCacheExpiryReChecks(t *testing.T) {
	router, calls := fakeRouter(t)
	now := time.Unix(1_000_000, 0)
	v := New(router.URL, false, discardLogger(), Options{
		TTL: 30 * time.Second,
		Now: func() time.Time { return now },
	})

	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("authenticate = %v, want nil", err)
	}
	// Within TTL: cached, no new call.
	now = now.Add(20 * time.Second)
	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("authenticate = %v, want nil", err)
	}
	if got := atomic.LoadInt64(calls); got != 1 {
		t.Fatalf("router hit %d times within TTL, want 1", got)
	}
	// Past TTL: re-check.
	now = now.Add(30 * time.Second)
	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("authenticate = %v, want nil", err)
	}
	if got := atomic.LoadInt64(calls); got != 2 {
		t.Errorf("router hit %d times after TTL, want 2", got)
	}
}

func TestRouterUnreachableFailsClosed(t *testing.T) {
	// Point at a closed port; the transport error must read as "not authenticated".
	v := New("http://127.0.0.1:1", false, discardLogger(), Options{
		Client: &http.Client{Timeout: 200 * time.Millisecond},
	})

	if err := v.Authenticate(req("session=valid")); err == nil {
		t.Fatalf("expected failure when router is unreachable")
	}
}
