package wsproxy

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

type allowAuth struct{}

func (allowAuth) Authenticate(*http.Request) *httpx.APIError { return nil }

type denyAuth struct{}

func (denyAuth) Authenticate(*http.Request) *httpx.APIError {
	return httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "no session")
}

// echoBackend accepts a websocket (offering the given subprotocols) and echoes every
// message back until the peer closes.
func echoBackend(t *testing.T, subprotocols ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: subprotocols})
		if err != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(readLimit)
		for {
			typ, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	return srv
}

// harness wires a registry over a state store and a wsproxy behind an httptest server.
type harness struct {
	srv   *httptest.Server
	store *state.Store
}

func newHarness(t *testing.T, auth Authenticator) *harness {
	t.Helper()
	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	reg := registry.New(store, filepath.Join(root, "user-plugins"), filepath.Join(root, "builtin"))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	New(reg, auth, logger).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return &harness{srv: srv, store: store}
}

func (h *harness) install(t *testing.T, name, manifestJSON, approval string, enabled bool) {
	t.Helper()
	err := h.store.Mutate(func(st *state.State) error {
		st.Plugins[name] = &state.Plugin{
			Name:     name,
			Source:   state.SourceUser,
			Approval: approval,
			Enabled:  enabled,
			Manifest: json.RawMessage(manifestJSON),
		}

		return nil
	})
	if err != nil {
		t.Fatalf("install %s: %v", name, err)
	}
}

// wsManifest builds a widget manifest declaring one websocket "stream" at path
// "stream" pointing at target, with the given declared subprotocols.
func wsManifest(name, target string, protocols []string, public bool) string {
	protoJSON, _ := json.Marshal(protocols)
	publicField := ""
	if public {
		publicField = `"public": true,`
	}

	return `{
  "manifestVersion": 2, "name": "` + name + `", "version": "1.0.0",
  "type": "widget", "label": "Svc", "entry": "index.js",
  "size": {"w": 4, "h": 3},
  "backend": {` + publicField + `
    "websockets": [
      {"id": "w1", "path": "stream", "target": "` + target + `", "protocols": ` + string(protoJSON) + `}
    ]
  }
}`
}

func wsURL(srv *httptest.Server, path string) string {
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + path
}

func dial(t *testing.T, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	return websocket.Dial(ctx, url, opts)
}

func TestWSProxyEcho(t *testing.T) {
	backend := echoBackend(t)
	h := newHarness(t, allowAuth{})
	h.install(t, "svc", wsManifest("svc", backend.URL, nil, false), state.ApprovalApproved, true)

	conn, _, err := dial(t, wsURL(h.srv, "/ws/plugins/svc/stream"), nil)
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	defer conn.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText || string(data) != "ping" {
		t.Errorf("echo = %q (%v), want ping/text", data, typ)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestWSProxySubprotocolNegotiated(t *testing.T) {
	backend := echoBackend(t, "mndw.v1", "chat")
	h := newHarness(t, allowAuth{})
	h.install(t, "svc", wsManifest("svc", backend.URL, []string{"mndw.v1"}, false), state.ApprovalApproved, true)

	conn, _, err := dial(t, wsURL(h.srv, "/ws/plugins/svc/stream"), &websocket.DialOptions{
		Subprotocols: []string{"mndw.v1"},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	if got := conn.Subprotocol(); got != "mndw.v1" {
		t.Errorf("negotiated subprotocol = %q, want mndw.v1", got)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestWSProxySubprotocolRejected(t *testing.T) {
	backend := echoBackend(t, "mndw.v1")
	h := newHarness(t, allowAuth{})
	// Manifest only allows mndw.v1; client offers something else → rejected before upgrade.
	h.install(t, "svc", wsManifest("svc", backend.URL, []string{"mndw.v1"}, false), state.ApprovalApproved, true)

	conn, _, err := dial(t, wsURL(h.srv, "/ws/plugins/svc/stream"), &websocket.DialOptions{
		Subprotocols: []string{"unsupported"},
	})
	if err == nil {
		conn.CloseNow()
		t.Fatalf("expected handshake failure for disjoint subprotocols")
	}
}

func TestWSProxyNotApproved(t *testing.T) {
	backend := echoBackend(t)
	h := newHarness(t, allowAuth{})
	h.install(t, "svc", wsManifest("svc", backend.URL, nil, false), state.ApprovalPending, false)

	conn, resp, err := dial(t, wsURL(h.srv, "/ws/plugins/svc/stream"), nil)
	if err == nil {
		conn.CloseNow()
		t.Fatalf("expected rejection for unapproved plugin")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %v, want 403", resp)
	}
}

func TestWSProxyUnknownRoute(t *testing.T) {
	h := newHarness(t, allowAuth{})

	conn, resp, err := dial(t, wsURL(h.srv, "/ws/plugins/ghost/stream"), nil)
	if err == nil {
		conn.CloseNow()
		t.Fatalf("expected rejection for unknown plugin")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %v, want 404", resp)
	}
}

func TestWSProxySessionGate(t *testing.T) {
	backend := echoBackend(t)
	h := newHarness(t, denyAuth{})
	h.install(t, "svc", wsManifest("svc", backend.URL, nil, false), state.ApprovalApproved, true)

	conn, resp, err := dial(t, wsURL(h.srv, "/ws/plugins/svc/stream"), nil)
	if err == nil {
		conn.CloseNow()
		t.Fatalf("expected rejection without a session")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %v, want 401", resp)
	}
}

func TestWSProxyPublicSkipsSessionGate(t *testing.T) {
	backend := echoBackend(t)
	h := newHarness(t, denyAuth{})
	h.install(t, "pub", wsManifest("pub", backend.URL, nil, true), state.ApprovalApproved, true)

	conn, _, err := dial(t, wsURL(h.srv, "/ws/plugins/pub/stream"), nil)
	if err != nil {
		t.Fatalf("public ws should bypass session gate: %v", err)
	}
	defer conn.CloseNow()
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestNormalizeTarget(t *testing.T) {
	cases := map[string]string{
		"ws://h:1":    "ws://h:1",
		"wss://h:1":   "wss://h:1",
		"http://h:1":  "ws://h:1",
		"https://h:1": "wss://h:1",
		"h:1":         "ws://h:1",
	}
	for in, want := range cases {
		if got := normalizeTarget(in); got != want {
			t.Errorf("normalizeTarget(%q) = %q, want %q", in, got, want)
		}
	}
}
