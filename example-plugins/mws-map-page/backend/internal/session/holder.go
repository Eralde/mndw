package session

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"mws-map-page/internal/auth"
	"mws-map-page/internal/credentials"
)

type Authenticator interface {
	Authenticate(context.Context, auth.Target, auth.Credentials, http.CookieJar) (auth.AuthResult, error)
}

type Clock interface{ Now() time.Time }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type session struct {
	mu            sync.Mutex
	target        auth.Target
	jar           http.CookieJar
	authenticated bool
	lastActivity  time.Time
	lastKeepalive time.Time
}

// Holder owns one controller session and one isolated jar per extender. Every
// operation on a session is serialized so re-auth cannot race a request.
type Holder struct {
	auth        Authenticator
	credentials *credentials.Store
	clock       Clock
	mu          sync.Mutex
	sessions    map[string]*session
	state       *State
	keepalive   time.Duration
}

func NewHolder(authenticator Authenticator, store *credentials.Store) *Holder {
	return &Holder{auth: authenticator, credentials: store, clock: realClock{}, sessions: make(map[string]*session), state: NewState(), keepalive: 200 * time.Second}
}

func (h *Holder) SetClock(clock Clock) {
	if clock != nil {
		h.clock = clock
	}
}

func (h *Holder) SetKeepaliveInterval(interval time.Duration) {
	if interval > 0 {
		h.keepalive = interval
	}
}

func (h *Holder) State() *State { return h.state }

func (h *Holder) CanAttempt(id string, now time.Time) bool {
	snapshot, ok := h.state.Snapshot(id)
	if !ok || snapshot.State == NodeOnline {
		return true
	}
	if snapshot.State == NodeFailed {
		return false
	}
	return snapshot.NextRetry.IsZero() || !now.Before(snapshot.NextRetry)
}

// Forget drops every jar and session authentication verdict. It is called on
// credential replacement and on the idempotent forget command.
func (h *Holder) Forget() {
	h.mu.Lock()
	sessions := make([]*session, 0, len(h.sessions))
	for _, current := range h.sessions {
		sessions = append(sessions, current)
	}
	h.sessions = make(map[string]*session)
	h.mu.Unlock()
	for _, current := range sessions {
		current.mu.Lock()
		current.jar = nil
		current.authenticated = false
		current.mu.Unlock()
	}
}

func (h *Holder) sessionFor(id string, target auth.Target) *session {
	h.mu.Lock()
	defer h.mu.Unlock()
	current := h.sessions[id]
	if current == nil {
		current = &session{target: target}
		h.sessions[id] = current
	} else if current.target.BaseURL != target.BaseURL {
		current.target = target
		current.jar = nil
		current.authenticated = false
	}
	return current
}

func (h *Holder) Authenticate(ctx context.Context, id string, target auth.Target) error {
	if h.auth == nil || h.credentials == nil {
		return errors.New("session holder is not configured")
	}
	current := h.sessionFor(id, target)
	current.mu.Lock()
	defer current.mu.Unlock()
	creds, state, ok := h.credentials.Snapshot()
	if !ok || state != credentials.StatePresent {
		return errors.New("credentials required")
	}
	defer wipe(creds.Password)
	result, err := h.auth.Authenticate(ctx, target, auth.Credentials{Username: creds.Username, Password: string(creds.Password)}, current.jar)
	if err != nil {
		var authErr *auth.AuthError
		if errors.As(err, &authErr) && authErr.Kind == auth.ErrorRejected && id == "controller" {
			h.credentials.MarkInvalid(creds.Epoch)
		}
		current.jar = nil
		current.authenticated = false
		h.state.RecordFailure(id, h.clock.Now())
		return err
	}
	if h.credentials.Epoch() != creds.Epoch {
		return errors.New("stale authentication completion")
	}
	now := h.clock.Now()
	h.state.RecordSuccess(id, now)
	current.jar = result.Jar
	current.authenticated = true
	current.lastActivity = now
	h.state.SetOnline(id, current.lastActivity)
	return nil
}

func (h *Holder) WithSession(ctx context.Context, id string, target auth.Target, operation func(context.Context, http.CookieJar) error) error {
	current := h.sessionFor(id, target)
	current.mu.Lock()
	defer current.mu.Unlock()
	if !current.authenticated || current.jar == nil {
		if err := h.authenticateLocked(ctx, id, current); err != nil {
			return err
		}
	}
	if err := operation(ctx, current.jar); err != nil {
		current.jar = nil
		current.authenticated = false
		h.state.RecordFailure(id, h.clock.Now())
		return err
	}
	current.lastActivity = h.clock.Now()
	return nil
}

func (h *Holder) authenticateLocked(ctx context.Context, id string, current *session) error {
	creds, state, ok := h.credentials.Snapshot()
	if !ok || state != credentials.StatePresent {
		return errors.New("credentials required")
	}
	defer wipe(creds.Password)
	result, err := h.auth.Authenticate(ctx, current.target, auth.Credentials{Username: creds.Username, Password: string(creds.Password)}, current.jar)
	if err != nil {
		var authErr *auth.AuthError
		if errors.As(err, &authErr) && authErr.Kind == auth.ErrorRejected && id == "controller" {
			h.credentials.MarkInvalid(creds.Epoch)
		}
		return err
	}
	if h.credentials.Epoch() != creds.Epoch {
		return errors.New("stale authentication completion")
	}
	now := h.clock.Now()
	h.state.RecordSuccess(id, now)
	current.jar = result.Jar
	current.authenticated = true
	current.lastActivity = now
	h.state.SetOnline(id, current.lastActivity)
	return nil
}

func (h *Holder) ShouldKeepalive(id string) bool {
	h.mu.Lock()
	current := h.sessions[id]
	h.mu.Unlock()
	if current == nil {
		return false
	}
	current.mu.Lock()
	defer current.mu.Unlock()
	return current.authenticated && h.clock.Now().Sub(current.lastActivity) >= h.keepalive
}

func (h *Holder) Keepalive(ctx context.Context, id string, target auth.Target, operation func(context.Context, http.CookieJar) error) error {
	if !h.ShouldKeepalive(id) {
		return nil
	}
	return h.WithSession(ctx, id, target, operation)
}

func wipe(buffer []byte) {
	for index := range buffer {
		buffer[index] = 0
	}
}
