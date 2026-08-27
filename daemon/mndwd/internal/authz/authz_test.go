package authz

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
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

func middlewareReq(method string, csrf bool) *http.Request {
	r := httptest.NewRequest(method, "/api/mgmt/list", nil)
	r.Header.Set("Cookie", "session=valid")
	if csrf {
		r.Header.Set("X-Mndw-Csrf", "1")
	}

	return r
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return fn(r)
}

func middlewareVerifier(dev bool) *Verifier {
	return New("http://router.test", dev, discardLogger(), Options{
		Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
				Request:    r,
			}, nil
		})},
	})
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

func TestMiddlewareRequiresCSRFForUnsafeMethods(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			v := middlewareVerifier(false)
			called := false
			handler := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))

			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, middlewareReq(method, false))

			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
			}
			if !strings.Contains(recorder.Body.String(), "CSRF_REQUIRED") {
				t.Fatalf("body = %q, want CSRF_REQUIRED", recorder.Body.String())
			}
			if called {
				t.Fatal("middleware called handler without CSRF")
			}
		})
	}
}

func TestMiddlewareAllowsSafeMethodsWithoutCSRF(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			v := middlewareVerifier(false)
			called := false
			handler := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))

			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, middlewareReq(method, false))

			if recorder.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
			}
			if !called {
				t.Fatal("middleware did not call handler for safe method")
			}
		})
	}
}

func TestMiddlewareAllowsUnsafeMethodsWithCSRF(t *testing.T) {
	v := middlewareVerifier(false)
	called := false
	handler := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, middlewareReq(http.MethodPost, true))

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
	if !called {
		t.Fatal("middleware did not call handler with CSRF")
	}
}

func TestDevModeMiddlewareStillRequiresCSRF(t *testing.T) {
	v := middlewareVerifier(true)
	handler := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, middlewareReq(http.MethodPost, false))

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
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
