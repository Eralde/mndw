package session

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"

	"mndw.local/device-auth"
	"mws-page/internal/credentials"
)

type fakeAuth struct {
	calls int
	err   error
}

func (f *fakeAuth) Authenticate(_ context.Context, _ auth.Target, _ auth.Credentials, jar http.CookieJar) (auth.AuthResult, error) {
	f.calls++
	if f.err != nil {
		return auth.AuthResult{}, f.err
	}
	if jar == nil {
		jar, _ = cookiejar.New(nil)
	}
	return auth.AuthResult{Jar: jar, Generation: "fake"}, nil
}

type fakeClock struct{ now time.Time }

func (f *fakeClock) Now() time.Time { return f.now }

func TestHolderUsesOneSessionAndKeepaliveSkipsRecentActivity(t *testing.T) {
	store := credentials.NewStore()
	store.Set("admin", []byte("secret"), 1)
	authenticator := &fakeAuth{}
	holder := NewHolder(authenticator, store)
	clock := &fakeClock{now: time.Unix(100, 0)}
	holder.SetClock(clock)
	called := 0
	operation := func(context.Context, http.CookieJar) error { called++; return nil }
	if err := holder.WithSession(context.Background(), "controller", auth.Target{BaseURL: "http://router"}, operation); err != nil {
		t.Fatal(err)
	}
	if err := holder.Keepalive(context.Background(), "controller", auth.Target{BaseURL: "http://router"}, operation); err != nil {
		t.Fatal(err)
	}
	if authenticator.calls != 1 || called != 1 {
		t.Fatalf("auth calls = %d, operation calls = %d", authenticator.calls, called)
	}
	clock.now = clock.now.Add(201 * time.Second)
	if err := holder.Keepalive(context.Background(), "controller", auth.Target{BaseURL: "http://router"}, operation); err != nil {
		t.Fatal(err)
	}
	if called != 2 {
		t.Fatalf("keepalive operation calls = %d, want 2", called)
	}
}

func TestWithSessionAuthFailureDoesNotRecordBackoff(t *testing.T) {
	store := credentials.NewStore()
	store.Set("admin", []byte("secret"), 1)
	holder := NewHolder(&fakeAuth{err: errors.New("transport failed")}, store)
	target := auth.Target{BaseURL: "http://router"}
	before, _ := holder.State().Snapshot("controller")
	if err := holder.WithSession(context.Background(), "controller", target, func(context.Context, http.CookieJar) error { return nil }); err == nil {
		t.Fatal("WithSession error = nil, want authentication error")
	}
	after, _ := holder.State().Snapshot("controller")
	if after.Failures != before.Failures || !after.NextRetry.Equal(before.NextRetry) {
		t.Fatalf("WithSession auth failure must not touch backoff: before=%+v after=%+v", before, after)
	}
}

func TestStateCapsRetryBackoffAndMarksNodeFailed(t *testing.T) {
	state := NewState()
	when := time.Unix(100, 0)
	for failure := 1; failure <= 4; failure++ {
		if failed := state.RecordFailure("node", when); failed {
			t.Fatalf("failure %d marked node failed early", failure)
		}
	}
	if snapshot, _ := state.Snapshot("node"); snapshot.NextRetry.Sub(when) != 30*time.Second {
		t.Fatalf("retry delay = %s, want 30s", snapshot.NextRetry.Sub(when))
	}
	if failed := state.RecordFailure("node", when); !failed {
		t.Fatal("fifth failure did not mark node failed")
	}
	if snapshot, _ := state.Snapshot("node"); snapshot.State != NodeFailed {
		t.Fatalf("state = %q, want %q", snapshot.State, NodeFailed)
	}
}
