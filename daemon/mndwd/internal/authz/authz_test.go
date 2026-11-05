package authz

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/httpx"
)

// fakeDevice accepts the cookie "session=valid" and rejects everything else,
// counting how many times it is hit so cache behavior can be asserted.
func fakeDevice(t *testing.T) (*httptest.Server, *int64) {
	t.Helper()

	var calls int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)

		if r.URL.Path != "/auth" {
			t.Errorf("device path = %q, want /auth", r.URL.Path)
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
	return New("http://device.test", dev, discardLogger(), Options{
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
	device, calls := fakeDevice(t)
	v := New(device.URL, false, discardLogger(), Options{})

	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("first authenticate = %v, want nil", err)
	}

	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("second authenticate = %v, want nil", err)
	}

	if got := atomic.LoadInt64(calls); got != 1 {
		t.Errorf("device hit %d times, want 1 (second should be cached)", got)
	}
}

func TestAuthenticateInvalidCookieRejected(t *testing.T) {
	device, _ := fakeDevice(t)
	v := New(device.URL, false, discardLogger(), Options{})

	err := v.Authenticate(req("session=nope"))
	if err == nil {
		t.Fatalf("expected rejection for invalid cookie")
	}

	if err.Status != http.StatusUnauthorized || err.Code != "UNAUTHORIZED" {
		t.Errorf("got status=%d code=%s, want 401/UNAUTHORIZED", err.Status, err.Code)
	}
}

func TestAuthenticateNoCookieShortCircuits(t *testing.T) {
	device, calls := fakeDevice(t)
	v := New(device.URL, false, discardLogger(), Options{})

	if err := v.Authenticate(req("")); err == nil {
		t.Fatalf("expected rejection with no cookie")
	}

	if got := atomic.LoadInt64(calls); got != 0 {
		t.Errorf("device hit %d times, want 0 (no cookie should not call device)", got)
	}
}

func TestDevModeBypassesDevice(t *testing.T) {
	device, calls := fakeDevice(t)
	v := New(device.URL, true, discardLogger(), Options{})

	if err := v.Authenticate(req("")); err != nil {
		t.Fatalf("dev mode should accept everything, got %v", err)
	}

	if got := atomic.LoadInt64(calls); got != 0 {
		t.Errorf("dev mode should never contact the device, hit %d times", got)
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
	device, calls := fakeDevice(t)
	now := time.Unix(1_000_000, 0)
	v := New(device.URL, false, discardLogger(), Options{
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
		t.Fatalf("device hit %d times within TTL, want 1", got)
	}

	// Past TTL: re-check.
	now = now.Add(30 * time.Second)

	if err := v.Authenticate(req("session=valid")); err != nil {
		t.Fatalf("authenticate = %v, want nil", err)
	}

	if got := atomic.LoadInt64(calls); got != 2 {
		t.Errorf("device hit %d times after TTL, want 2", got)
	}
}

func TestDeviceUnreachableFailsClosed(t *testing.T) {
	// Point at a closed port; the transport error must read as "not authenticated".
	v := New("http://127.0.0.1:1", false, discardLogger(), Options{
		Client: &http.Client{Timeout: 200 * time.Millisecond},
	})

	if err := v.Authenticate(req("session=valid")); err == nil {
		t.Fatalf("expected failure when device is unreachable")
	}
}

func TestCacheIsBounded(t *testing.T) {
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))

	t.Cleanup(device.Close)

	v := New(device.URL, false, discardLogger(), Options{MaxEntries: 16})

	for i := range 200 {
		if err := v.Authenticate(req(fmt.Sprintf("session=%d", i))); err == nil {
			t.Fatalf("cookie %d was authenticated, want rejection", i)
		}
	}

	v.mu.Lock()

	defer v.mu.Unlock()

	if got := len(v.cache); got > 16 {
		t.Fatalf("cache contains %d entries, want at most 16", got)
	}
}

func TestAuthenticatePositiveVerdictSurvivesInvalidCookieFlood(t *testing.T) {
	var calls atomic.Int64
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)

		if r.Header.Get("Cookie") == "good=1" {
			w.WriteHeader(http.StatusOK)

			return
		}

		w.WriteHeader(http.StatusUnauthorized)
	}))

	t.Cleanup(device.Close)

	now := time.Unix(1_000_000, 0)
	v := New(device.URL, false, discardLogger(), Options{
		MaxEntries: 16,
		Now:        func() time.Time { return now },
	})

	if err := v.Authenticate(req("good=1")); err != nil {
		t.Fatalf("initial good cookie = %v, want nil", err)
	}

	for i := range 200 {
		if err := v.Authenticate(req(fmt.Sprintf("bad=%d", i))); err == nil {
			t.Fatalf("invalid cookie %d was authenticated, want rejection", i)
		}
	}

	calls.Store(0)

	if err := v.Authenticate(req("good=1")); err != nil {
		t.Fatalf("good cookie after invalid flood = %v, want nil", err)
	}

	if got := calls.Load(); got != 0 {
		t.Fatalf("device saw %d calls after cached good cookie, want 0", got)
	}
}

func TestAuthenticateCoalescesConcurrentChecks(t *testing.T) {
	var calls atomic.Int64
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
		}

		<-release
		w.WriteHeader(http.StatusOK)
	}))

	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		device.Close()
	})

	v := New(device.URL, false, discardLogger(), Options{})
	results := make(chan *httpx.APIError, 10)

	for range 10 {
		go func() {
			results <- v.Authenticate(req("same=1"))
		}()
	}

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("device did not receive the first auth request")
	}

	time.Sleep(50 * time.Millisecond)
	releaseOnce.Do(func() { close(release) })

	for range 10 {
		select {
		case err := <-results:
			if err != nil {
				t.Errorf("Authenticate() = %v, want nil", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("coalesced Authenticate calls did not finish")
		}
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("device saw %d calls for concurrent same-cookie checks, want 1", got)
	}

	if err := v.Authenticate(req("same=1")); err != nil {
		t.Fatalf("sequential Authenticate() = %v, want nil", err)
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("device saw %d calls after cached sequential check, want 1", got)
	}
}

func TestAuthenticateLimitsConcurrentUpstreamChecks(t *testing.T) {
	var current atomic.Int64
	var peak atomic.Int64
	release := make(chan struct{})
	var releaseOnce sync.Once
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		active := current.Add(1)

		for {
			previous := peak.Load()

			if active <= previous || peak.CompareAndSwap(previous, active) {
				break
			}
		}

		defer current.Add(-1)

		<-release
		w.WriteHeader(http.StatusOK)
	}))

	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		device.Close()
	})

	v := New(device.URL, false, discardLogger(), Options{MaxConcurrentChecks: 4})
	results := make(chan *httpx.APIError, 20)

	for i := range 20 {
		go func(i int) {
			results <- v.Authenticate(req(fmt.Sprintf("session=%d", i)))
		}(i)
	}

	time.Sleep(100 * time.Millisecond)
	releaseOnce.Do(func() { close(release) })

	for range 20 {
		select {
		case err := <-results:
			if err != nil {
				t.Errorf("Authenticate() = %v, want nil", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("limited Authenticate calls did not finish")
		}
	}

	if got := peak.Load(); got > 4 {
		t.Fatalf("peak concurrent device calls = %d, want at most 4", got)
	}
}

func TestAuthenticateLeaderCancellationDoesNotFailFollowers(t *testing.T) {
	var calls atomic.Int64
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
		}

		<-release
		w.WriteHeader(http.StatusOK)
	}))

	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		device.Close()
	})

	v := New(device.URL, false, discardLogger(), Options{})
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderResult := make(chan *httpx.APIError, 1)

	go func() {
		leaderResult <- v.Authenticate(req("same=1").WithContext(leaderCtx))
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not reach the device")
	}

	followerResults := make(chan *httpx.APIError, 3)

	for range 3 {
		go func() {
			followerResults <- v.Authenticate(req("same=1"))
		}()
	}

	time.Sleep(50 * time.Millisecond)
	cancelLeader()
	releaseOnce.Do(func() { close(release) })

	for range 3 {
		select {
		case err := <-followerResults:
			if err != nil {
				t.Errorf("follower Authenticate() = %v, want nil", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("followers did not finish")
		}
	}

	<-leaderResult

	if got := calls.Load(); got != 1 {
		t.Fatalf("device saw %d calls for leader and followers, want 1 shared check", got)
	}
}

func TestAuthenticateFollowerCancellationReturnsPromptly(t *testing.T) {
	var calls atomic.Int64
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)

		entered <- struct{}{}

		<-release
		w.WriteHeader(http.StatusOK)
	}))

	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		device.Close()
	})

	v := New(device.URL, false, discardLogger(), Options{})
	leaderResult := make(chan *httpx.APIError, 1)

	go func() {
		leaderResult <- v.Authenticate(req("same=1"))
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not reach the device")
	}

	followerCtx, cancelFollower := context.WithCancel(context.Background())
	followerResult := make(chan *httpx.APIError, 1)

	go func() {
		followerResult <- v.Authenticate(req("same=1").WithContext(followerCtx))
	}()

	time.AfterFunc(50*time.Millisecond, cancelFollower)

	started := time.Now()

	select {
	case err := <-followerResult:
		if err == nil || err.Status != http.StatusUnauthorized {
			t.Fatalf("follower Authenticate() = %v, want 401", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled follower did not return within 500ms")
	}

	if elapsed := time.Since(started); elapsed >= 500*time.Millisecond {
		t.Fatalf("cancelled follower returned after %s, want under 500ms", elapsed)
	}

	select {
	case <-release:
		t.Fatal("device was released before follower returned")
	default:
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("device saw %d calls while follower was cancelled, want 1 shared check", got)
	}

	releaseOnce.Do(func() { close(release) })
	<-leaderResult
}

func TestAuthenticateSemaphoreTimeoutIsNotCached(t *testing.T) {
	var calls atomic.Int64
	firstEntered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)

		if r.Header.Get("Cookie") == "first=1" {
			close(firstEntered)
			<-release
			w.WriteHeader(http.StatusOK)

			return
		}

		w.WriteHeader(http.StatusUnauthorized)
	}))

	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		device.Close()
	})

	v := New(device.URL, false, discardLogger(), Options{MaxConcurrentChecks: 1})
	v.checkTimeout = time.Second
	firstResult := make(chan *httpx.APIError, 1)

	go func() {
		firstResult <- v.Authenticate(req("first=1"))
	}()

	select {
	case <-firstEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("first request did not reach the device")
	}

	v.checkTimeout = 100 * time.Millisecond
	started := time.Now()
	err := v.Authenticate(req("second=1"))
	if err == nil || err.Status != http.StatusUnauthorized {
		t.Fatalf("second Authenticate() = %v, want 401", err)
	}

	if elapsed := time.Since(started); elapsed < 80*time.Millisecond || elapsed >= time.Second {
		t.Fatalf("second Authenticate() returned after %s, want roughly 100ms", elapsed)
	}

	key := hashKey("second=1")

	v.mu.Lock()

	_, cached := v.cache[key]

	v.mu.Unlock()

	if cached {
		t.Fatal("semaphore timeout was cached, want no cache entry")
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("device saw %d calls, want only first request", got)
	}

	releaseOnce.Do(func() { close(release) })

	if err := <-firstResult; err != nil {
		t.Fatalf("first Authenticate() = %v, want nil", err)
	}
}
