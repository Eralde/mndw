// Package authz is the daemon's session gate (design §5.4). It has no session store
// of its own: it replays a request's cookies against the router's /auth endpoint and
// trusts the router's verdict, caching it per cookie for a short TTL so a burst of
// plugin calls costs one upstream check. --dev accepts everything (the bypass is
// logged loudly at startup). backend.public routes skip this gate entirely; that
// decision lives with the caller (dispatch/wsproxy) since it depends on the plugin.
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

// negativeTTL caps how long a rejection is cached: short enough that a user who has
// just logged in is not locked out for the full positive TTL, long enough to blunt a
// flood of invalid cookies hammering the router.
const negativeTTL = 5 * time.Second

// Verifier validates that a request carries a live router session.
type Verifier struct {
	routerURL string
	client    *http.Client
	ttl       time.Duration
	dev       bool
	logger    *slog.Logger
	now       func() time.Time

	mu    sync.Mutex
	cache map[string]entry
}

type entry struct {
	ok      bool
	expires time.Time
}

// Options tune a Verifier; the zero value is fine (sensible defaults applied).
type Options struct {
	// TTL overrides the positive-verdict cache lifetime (default 30s).
	TTL time.Duration
	// Client overrides the HTTP client used to reach the router (default 5s timeout).
	Client *http.Client
	// Now overrides the clock (tests inject a controllable one).
	Now func() time.Time
}

// New constructs a Verifier. In dev mode the router is never contacted.
func New(routerURL string, dev bool, logger *slog.Logger, opts Options) *Verifier {
	v := &Verifier{
		routerURL: strings.TrimRight(routerURL, "/"),
		client:    opts.Client,
		ttl:       opts.TTL,
		dev:       dev,
		logger:    logger,
		now:       opts.Now,
		cache:     map[string]entry{},
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

	ok := v.replay(r.Context(), cookie)
	v.store(key, ok)
	if ok {
		return nil
	}

	return unauthorized()
}

// Middleware wraps next with the session gate, writing the 401 envelope on failure.
// Used for /api/mgmt/* which is always gated; dispatch/ws call Authenticate directly
// so they can honor backend.public.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiErr := v.Authenticate(r); apiErr != nil {
			httpx.WriteError(w, v.logger, apiErr)

			return
		}
		next.ServeHTTP(w, r)
	})
}

// replay asks the router whether the cookie names a live session. Any transport
// failure is treated as "not authenticated" — the daemon fails closed.
func (v *Verifier) replay(ctx context.Context, cookie string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.routerURL+"/auth", nil)
	if err != nil {
		v.logger.Error("authz: build auth request failed", "error", err)

		return false
	}
	req.Header.Set("Cookie", cookie)

	resp, err := v.client.Do(req)
	if err != nil {
		v.logger.Warn("authz: router auth request failed", "error", err)

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
	ttl := v.ttl
	if !ok {
		ttl = negativeTTL
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	v.cache[key] = entry{ok: ok, expires: v.now().Add(ttl)}
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
