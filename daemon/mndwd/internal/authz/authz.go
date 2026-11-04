// Package authz is the daemon's session gate. It has no session store
// of its own: it replays a request's cookies against the device's /auth endpoint and
// trusts the device's verdict, using a bounded per-cookie TTL cache and coalesced,
// concurrency-limited upstream checks. --dev accepts everything (the bypass is
// logged loudly at startup). Backend route access is decided by the unified
// backend gateway because it depends on the matched manifest capability.
package authz

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"mndwd/internal/httpx"
)

// defaultTTL is how long a positive verdict is trusted (design: ~30s).
const defaultTTL = 30 * time.Second

const maxCacheEntries = 1024

const maxConcurrentChecks = 4

const checkTimeout = 5 * time.Second

// negativeTTL caps how long a rejection is cached: short enough that a user who has
// just logged in is not locked out for the full positive TTL, long enough to blunt a
// flood of invalid cookies hammering the device.
const negativeTTL = 5 * time.Second

// Verifier validates that a request carries a live device session.
type Verifier struct {
	deviceURL    string
	client       *http.Client
	ttl          time.Duration
	dev          bool
	logger       *slog.Logger
	now          func() time.Time
	checkTimeout time.Duration

	mu         sync.Mutex
	cache      map[string]entry
	inflight   map[string]*check
	checks     chan struct{}
	maxEntries int
}

type entry struct {
	ok      bool
	expires time.Time
}

type check struct {
	done      chan struct{}
	ok        bool
	cacheable bool
}

// Options tune a Verifier; the zero value is fine (sensible defaults applied).
type Options struct {
	// TTL overrides the positive-verdict cache lifetime (default 30s).
	TTL time.Duration
	// Client overrides the HTTP client used to reach the device (default 5s timeout).
	Client *http.Client
	// Now overrides the clock (tests inject a controllable one).
	Now func() time.Time
	// MaxEntries bounds the number of cached verdicts (default 1024).
	MaxEntries int
	// MaxConcurrentChecks bounds concurrent upstream checks (default 4).
	MaxConcurrentChecks int
}

// New constructs a Verifier. In dev mode the device is never contacted.
func New(deviceURL string, dev bool, logger *slog.Logger, opts Options) *Verifier {
	maxEntries := opts.MaxEntries

	if maxEntries <= 0 {
		maxEntries = maxCacheEntries
	}

	maxConcurrent := opts.MaxConcurrentChecks

	if maxConcurrent <= 0 {
		maxConcurrent = maxConcurrentChecks
	}

	v := &Verifier{
		deviceURL:    strings.TrimRight(deviceURL, "/"),
		client:       opts.Client,
		ttl:          opts.TTL,
		dev:          dev,
		logger:       logger,
		now:          opts.Now,
		checkTimeout: checkTimeout,
		cache:        map[string]entry{},
		inflight:     map[string]*check{},
		checks:       make(chan struct{}, maxConcurrent),
		maxEntries:   maxEntries,
	}

	if v.client == nil {
		v.client = &http.Client{Timeout: 5 * time.Second}
	}

	if v.ttl == 0 {
		v.ttl = defaultTTL
	}

	if v.now == nil {
		v.now = time.Now
	}

	return v
}

// Authenticate reports whether r may proceed. It returns nil when the request
// carries a valid session (or dev mode is on), or a 401 *httpx.APIError otherwise.
func (v *Verifier) Authenticate(r *http.Request) *httpx.APIError {
	if v.dev {
		return nil
	}

	cookie := r.Header.Get("Cookie")

	if cookie == "" {
		return unauthorized()
	}

	key := hashKey(cookie)

	if verdict, cached := v.lookup(key); cached {
		if verdict {
			return nil
		}

		return unauthorized()
	}

	ok := v.check(r.Context(), key, cookie)

	if ok {
		return nil
	}

	return unauthorized()
}

// Middleware wraps next with the session gate, writing the 401 envelope on failure.
// Used for /api/mgmt/*, while the backend gateway calls Authenticate after
// resolving its route access.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiErr := v.Authenticate(r); apiErr != nil {
			httpx.WriteError(w, v.logger, apiErr)

			return
		}

		if requiresCSRF(r.Method) && !httpx.RequireCSRF(w, v.logger, r) {
			return
		}

		next.ServeHTTP(w, r)
	})
}

func requiresCSRF(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

// replay asks the device whether the cookie names a live session. Any transport
// failure is treated as "not authenticated" — the daemon fails closed.
func (v *Verifier) replay(ctx context.Context, cookie string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.deviceURL+"/auth", nil)
	if err != nil {
		v.logger.Error("authz: build auth request failed", "error", err)

		return false
	}

	req.Header.Set("Cookie", cookie)

	resp, err := v.client.Do(req)
	if err != nil {
		v.logger.Warn("authz: device auth request failed", "error", err)

		return false
	}

	defer resp.Body.Close()

	_, _ = io.Copy(io.Discard, resp.Body)

	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func (v *Verifier) lookup(key string) (verdict, cached bool) {
	v.mu.Lock()

	defer v.mu.Unlock()

	e, ok := v.cache[key]

	if !ok {
		return false, false
	}

	if v.now().After(e.expires) {
		delete(v.cache, key)

		return false, false
	}

	return e.ok, true
}

func (v *Verifier) store(key string, ok bool) {
	v.mu.Lock()

	defer v.mu.Unlock()

	v.storeLocked(key, ok)
}

func (v *Verifier) storeLocked(key string, ok bool) {
	ttl := v.ttl

	if !ok {
		ttl = negativeTTL
	}

	if _, exists := v.cache[key]; !exists && len(v.cache) >= v.maxEntries {
		now := v.now()

		for cachedKey, e := range v.cache {
			if now.After(e.expires) {
				delete(v.cache, cachedKey)
			}
		}

		if len(v.cache) >= v.maxEntries {
			var earliestKey string
			var earliest time.Time
			found := false

			for cachedKey, e := range v.cache {
				if !found || e.expires.Before(earliest) {
					earliestKey = cachedKey
					earliest = e.expires
					found = true
				}
			}

			if found {
				delete(v.cache, earliestKey)
			}
		}
	}

	v.cache[key] = entry{ok: ok, expires: v.now().Add(ttl)}
}

func (v *Verifier) check(ctx context.Context, key, cookie string) (ok bool) {
	v.mu.Lock()

	if c, exists := v.inflight[key]; exists {
		v.mu.Unlock()

		select {
		case <-c.done:
			return c.ok
		case <-ctx.Done():
			return false
		}
	}

	c := &check{done: make(chan struct{})}
	v.inflight[key] = c

	v.mu.Unlock()

	cacheable := false

	defer func() {
		v.mu.Lock()
		delete(v.inflight, key)

		c.ok = ok
		c.cacheable = cacheable

		if cacheable {
			v.storeLocked(key, ok)
		}

		close(c.done)
		v.mu.Unlock()
	}()

	checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), v.checkTimeout)

	defer cancel()

	select {
	case v.checks <- struct{}{}:
		func() {
			defer func() { <-v.checks }()

			ok = v.replay(checkCtx, cookie)
		}()

		cacheable = true
	case <-checkCtx.Done():
		return false
	}

	return ok
}

// hashKey derives the cache key from the cookie header so raw session credentials are
// not held in memory as map keys.
func hashKey(cookie string) string {
	sum := sha256.Sum256([]byte(cookie))

	return hex.EncodeToString(sum[:])
}

func unauthorized() *httpx.APIError {
	return httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "a valid device session is required")
}
