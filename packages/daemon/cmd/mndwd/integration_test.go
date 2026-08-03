package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mndwd/internal/authz"
	"mndwd/internal/palette"
	"mndwd/internal/state"
)

// buildServer assembles the full daemon handler (mgmt + dispatch + ws behind the
// given verifier) over temp dirs and returns it as an httptest server plus the
// resolved config.
func buildServer(t *testing.T, verifier *authz.Verifier) (*httptest.Server, Config) {
	return buildServerMode(t, verifier, false)
}

func buildServerMode(t *testing.T, verifier *authz.Verifier, dev bool) (*httptest.Server, Config) {
	t.Helper()
	root := t.TempDir()
	cfg := Config{
		DataDir:           filepath.Join(root, "data"),
		UserPluginsDir:    filepath.Join(root, "user-plugins"),
		BuiltinPluginsDir: filepath.Join(root, "builtin"),
		Dev:               dev,
		Opkg:              "stub",
	}
	store, err := state.Open(cfg.StateFile())
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	paletteStore, err := palette.Open(cfg.PaletteFile())
	if err != nil {
		t.Fatalf("palette.Open: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, _, _, _, _ := assemble(cfg, store, paletteStore, verifier, logger)

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return srv, cfg
}

func devServer(t *testing.T) (*httptest.Server, Config) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	return buildServerMode(t, authz.New("", true, logger, authz.Options{}), true)
}

func TestIntegrationPaletteRouteAuthorization(t *testing.T) {
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") == "session=ok" {
			w.WriteHeader(http.StatusOK)

			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(router.Close)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, _ := buildServer(t, authz.New(router.URL, false, logger, authz.Options{}))

	cases := []struct {
		method string
		cookie string
		want   int
	}{
		{http.MethodGet, "", http.StatusOK},
		{http.MethodPut, "", http.StatusUnauthorized},
		{http.MethodDelete, "", http.StatusUnauthorized},
		{http.MethodDelete, "session=ok", http.StatusNoContent},
	}

	for _, tc := range cases {
		var body []byte
		if tc.method == http.MethodPut {
			body = []byte(`{}`)
		}

		resp := do(t, tc.method, srv.URL+"/api/mgmt/palette", tc.cookie, "", body)
		if resp.StatusCode != tc.want {
			t.Errorf("%s /api/mgmt/palette cookie=%q = %d, want %d",
				tc.method, tc.cookie, resp.StatusCode, tc.want)
		}
		resp.Body.Close()
	}

	resp := do(t, http.MethodGet, srv.URL+"/api/mgmt/list", "", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("unauthenticated GET /api/mgmt/list = %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestIntegrationDevExposesExtenderAccessRoute(t *testing.T) {
	srv, _ := devServer(t)

	resp := do(t, http.MethodGet, srv.URL+"/api/mndw/extender-access", "", "", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("dev extender-access without CSRF = %d, want 403", resp.StatusCode)
	}
	resp.Body.Close()

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/mndw/extender-access", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Mndw-Csrf", "1")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dev extender-access = %d, want 200", resp.StatusCode)
	}
	if body := bodyString(t, resp); !strings.Contains(body, `"enabled":false`) {
		t.Fatalf("dev extender-access body = %q, want disabled state", body)
	}
}

// echoWSBackend accepts a websocket (offering the given subprotocols) and echoes.
func echoWSBackend(t *testing.T, subprotocols ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: subprotocols})
		if err != nil {
			return
		}
		defer c.CloseNow()
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

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	return buf.Bytes()
}

// do issues an HTTP request with an optional cookie and returns the response.
func do(t *testing.T, method, url, cookie, contentType string, body []byte) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}

	return resp
}

func uploadZip(t *testing.T, srv *httptest.Server, cookie string, zipBytes []byte) *http.Response {
	return do(t, http.MethodPost, srv.URL+"/api/mgmt/upload", cookie, "application/zip", zipBytes)
}

func postName(t *testing.T, srv *httptest.Server, cookie, path, name string) *http.Response {
	body, _ := json.Marshal(map[string]string{"name": name})

	return do(t, http.MethodPost, srv.URL+path, cookie, "application/json", body)
}

func bodyString(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)

	return string(b)
}

func errCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}

	return env.Error.Code
}

// fullManifest builds a backend widget declaring an endpoint, a websocket (pointed at
// wsTarget), and daemon start/stop hooks. public toggles backend.public.
func fullManifest(name, wsTarget string, public bool) string {
	publicField := ""
	if public {
		publicField = `"public": true,`
	}

	return fmt.Sprintf(`{
  "manifestVersion": 2, "name": %q, "version": "1.0.0",
  "type": "widget", "label": "Full", "entry": "index.js",
  "size": {"w": 4, "h": 3},
  "backend": {
    %s
    "opkg": ["curl"],
    "scripts": [{"id": "s1", "source": "backend/hello.sh", "runtime": "sh"}],
    "endpoints": [{"id": "e1", "method": "GET", "path": "hello", "scriptId": "s1"}],
    "websockets": [{"id": "w1", "path": "stream", "target": %q, "protocols": ["mndw.v1"]}],
    "daemon": {"start": "backend/start.sh", "stop": "backend/stop.sh"}
  }
}`, name, publicField, wsTarget)
}

const helloScript = `#!/bin/sh
echo "Status: 200"
echo "Content-Type: application/json"
echo ""
printf '{"msg":"hello","plugin":"%s"}' "$MNDW_PLUGIN_ID"
`

// start/stop hooks manage a marker file in the plugin dir, standing in for a real
// long-running daemon so the lifecycle can be asserted deterministically.
const startHook = "#!/bin/sh\ntouch daemon.running\n"
const stopHook = "#!/bin/sh\nrm -f daemon.running\n"

func fullPluginFiles(manifest string) map[string]string {
	return map[string]string{
		"manifest.json":    manifest,
		"index.js":         "export function createInstance(){}",
		"backend/hello.sh": helloScript,
		"backend/start.sh": startHook,
		"backend/stop.sh":  stopHook,
	}
}

func markerPath(cfg Config, name string) string {
	return filepath.Join(cfg.UserPluginsDir, name, "daemon.running")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)

	return err == nil
}

func TestIntegrationFullLifecycle(t *testing.T) {
	echo := echoWSBackend(t, "mndw.v1")
	srv, cfg := devServer(t)

	m := fullManifest("full", echo.URL, false)
	zipBytes := makeZip(t, fullPluginFiles(m))

	// Upload → pending.
	if resp := uploadZip(t, srv, "", zipBytes); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("upload = %d, want 202", resp.StatusCode)
	} else {
		resp.Body.Close()
	}

	// Dispatch before approval → 403 NOT_APPROVED.
	resp := do(t, http.MethodGet, srv.URL+"/api/plugins/full/hello", "", "", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pre-approve dispatch = %d, want 403", resp.StatusCode)
	}
	if c := errCode(t, resp); c != "NOT_APPROVED" {
		t.Fatalf("pre-approve code = %s, want NOT_APPROVED", c)
	}

	// Approve → daemon started (marker present).
	if resp := postName(t, srv, "", "/api/mgmt/approve", "full"); resp.StatusCode != http.StatusOK {
		t.Fatalf("approve = %d, want 200 (%s)", resp.StatusCode, bodyString(t, resp))
	} else {
		resp.Body.Close()
	}
	if !fileExists(markerPath(cfg, "full")) {
		t.Fatalf("daemon start hook did not run (no marker)")
	}

	// Dispatch now works.
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/full/hello", "", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dispatch = %d, want 200", resp.StatusCode)
	}
	if b := bodyString(t, resp); !strings.Contains(b, `"plugin":"full"`) {
		t.Errorf("dispatch body = %q", b)
	}

	// WebSocket echo through the proxy.
	assertWSEcho(t, srv, "full", "")

	// Disable → daemon stopped, routes killed.
	if resp := postName(t, srv, "", "/api/mgmt/disable", "full"); resp.StatusCode != http.StatusOK {
		t.Fatalf("disable = %d, want 200", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	if fileExists(markerPath(cfg, "full")) {
		t.Errorf("daemon stop hook did not run (marker remains)")
	}
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/full/hello", "", "", nil)
	if resp.StatusCode != http.StatusForbidden || errCode(t, resp) != "DISABLED" {
		t.Errorf("disabled dispatch should be 403 DISABLED, got %d", resp.StatusCode)
	}

	// Enable → daemon restarted, routes live.
	if resp := postName(t, srv, "", "/api/mgmt/enable", "full"); resp.StatusCode != http.StatusOK {
		t.Fatalf("enable = %d, want 200", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	if !fileExists(markerPath(cfg, "full")) {
		t.Errorf("daemon start hook did not run on enable")
	}
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/full/hello", "", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("re-enabled dispatch = %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()

	// Delete → files gone.
	if resp := postName(t, srv, "", "/api/mgmt/delete", "full"); resp.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d, want 200", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	if fileExists(filepath.Join(cfg.UserPluginsDir, "full")) {
		t.Errorf("plugin files should be gone after delete")
	}
}

func TestIntegrationDenyPath(t *testing.T) {
	echo := echoWSBackend(t, "mndw.v1")
	srv, cfg := devServer(t)
	zipBytes := makeZip(t, fullPluginFiles(fullManifest("full", echo.URL, false)))

	uploadZip(t, srv, "", zipBytes).Body.Close()
	if resp := postName(t, srv, "", "/api/mgmt/deny", "full"); resp.StatusCode != http.StatusOK {
		t.Fatalf("deny = %d, want 200", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	if fileExists(filepath.Join(cfg.StagingDir(), "full")) {
		t.Errorf("staging should be gone after deny")
	}
	// Dispatch to a denied plugin → 404 (not installed).
	resp := do(t, http.MethodGet, srv.URL+"/api/plugins/full/hello", "", "", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("denied dispatch = %d, want 404", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestIntegrationPublicFlagAndSessionGate(t *testing.T) {
	// Non-dev verifier backed by a fake router that accepts "session=ok".
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") == "session=ok" {
			w.WriteHeader(http.StatusOK)

			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(router.Close)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, _ := buildServer(t, authz.New(router.URL, false, logger, authz.Options{}))

	// mgmt is gated: no cookie → 401, valid cookie → 200.
	if resp := do(t, http.MethodGet, srv.URL+"/api/mgmt/list", "", "", nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("mgmt no-cookie = %d, want 401", resp.StatusCode)
	} else {
		resp.Body.Close()
	}

	// Install a public and a private plugin (cookie required for mgmt).
	installNoDaemon(t, srv, "session=ok", "pubby", true)
	installNoDaemon(t, srv, "session=ok", "privy", false)

	// Public dispatch without a cookie → 200 (session gate skipped).
	resp := do(t, http.MethodGet, srv.URL+"/api/plugins/pubby/hello", "", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("public dispatch no-cookie = %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()

	// Private dispatch without a cookie → 401 (gated before existence leak).
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/privy/hello", "", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("private dispatch no-cookie = %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()

	// Private dispatch with a valid cookie → 200.
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/privy/hello", "session=ok", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("private dispatch with cookie = %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()
}

// installNoDaemon uploads and approves a backend plugin (endpoint only, no daemon/ws
// dependence on running processes) with the given public flag.
func installNoDaemon(t *testing.T, srv *httptest.Server, cookie, name string, public bool) {
	t.Helper()
	publicField := ""
	if public {
		publicField = `"public": true,`
	}
	m := fmt.Sprintf(`{
  "manifestVersion": 2, "name": %q, "version": "1.0.0",
  "type": "widget", "label": "P", "entry": "index.js",
  "size": {"w": 4, "h": 3},
  "backend": {
    %s
    "scripts": [{"id": "s1", "source": "backend/hello.sh", "runtime": "sh"}],
    "endpoints": [{"id": "e1", "method": "GET", "path": "hello", "scriptId": "s1"}]
  }
}`, name, publicField)
	files := map[string]string{
		"manifest.json":    m,
		"index.js":         "x",
		"backend/hello.sh": helloScript,
	}
	if resp := uploadZip(t, srv, cookie, makeZip(t, files)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("install upload %s = %d, want 202", name, resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	if resp := postName(t, srv, cookie, "/api/mgmt/approve", name); resp.StatusCode != http.StatusOK {
		t.Fatalf("install approve %s = %d, want 200", name, resp.StatusCode)
	} else {
		resp.Body.Close()
	}
}

// assertWSEcho dials the plugin's websocket through the proxy and checks a round trip.
func assertWSEcho(t *testing.T, srv *httptest.Server, plugin, cookie string) {
	t.Helper()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/plugins/" + plugin + "/stream"
	opts := &websocket.DialOptions{Subprotocols: []string{"mndw.v1"}}
	if cookie != "" {
		opts.HTTPHeader = http.Header{"Cookie": {cookie}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		t.Fatalf("ws dial through proxy: %v", err)
	}
	defer conn.CloseNow()

	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("ws write: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	if string(data) != "ping" {
		t.Errorf("ws echo = %q, want ping", data)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

// backendEchoDir locates the real backend-echo example plugin relative to this
// package dir (go test runs with the working directory set to the package). The
// integration test loads the shipped manifest + echo.cgi — the two files the
// backend/dispatch path needs — so it exercises the real script, not a hand-copied
// fixture. The frontend bundle is not involved in dispatch.
const backendEchoDir = "../../../../example-plugins/backend-echo"

func backendEchoFiles(t *testing.T) map[string]string {
	t.Helper()
	manifestBytes, err := os.ReadFile(filepath.Join(backendEchoDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read backend-echo manifest (corpus not located?): %v", err)
	}
	scriptBytes, err := os.ReadFile(filepath.Join(backendEchoDir, "backend", "echo.cgi"))
	if err != nil {
		t.Fatalf("read backend-echo echo.cgi: %v", err)
	}

	return map[string]string{
		"manifest.json":    string(manifestBytes),
		"backend/echo.cgi": string(scriptBytes),
	}
}

type echoEnvelope struct {
	Method        string `json:"method"`
	Query         string `json:"query"`
	ContentType   string `json:"contentType"`
	ContentLength string `json:"contentLength"`
	PluginID      string `json:"pluginId"`
	EndpointID    string `json:"endpointId"`
	Body          string `json:"body"`
}

func decodeEcho(t *testing.T, resp *http.Response) echoEnvelope {
	t.Helper()
	defer resp.Body.Close()
	var env echoEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatalf("decode echo envelope: %v", err)
	}

	return env
}

// TestIntegrationScriptsOnlyDispatch exercises the pure sh-scripts backend path
// (no daemon hooks, no ws) end to end: upload → pending → approve → dispatch, plus
// the CGI Status: override, a custom response header, and stdin-body echo.
func TestIntegrationScriptsOnlyDispatch(t *testing.T) {
	srv, _ := devServer(t)
	zipBytes := makeZip(t, backendEchoFiles(t))

	if resp := uploadZip(t, srv, "", zipBytes); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("upload = %d, want 202", resp.StatusCode)
	}

	// Pre-approve dispatch is gated.
	resp := do(t, http.MethodGet, srv.URL+"/api/plugins/backend-echo/echo", "", "", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pre-approve = %d, want 403", resp.StatusCode)
	}
	if c := errCode(t, resp); c != "NOT_APPROVED" {
		t.Fatalf("pre-approve code = %s, want NOT_APPROVED", c)
	}

	if resp := postName(t, srv, "", "/api/mgmt/approve", "backend-echo"); resp.StatusCode != http.StatusOK {
		t.Fatalf("approve = %d, want 200 (%s)", resp.StatusCode, bodyString(t, resp))
	}

	// GET with a Status: override and a custom header.
	resp = do(t, http.MethodGet, srv.URL+"/api/plugins/backend-echo/echo?status=418", "", "", nil)
	if resp.StatusCode != http.StatusTeapot {
		t.Fatalf("GET status override = %d, want 418", resp.StatusCode)
	}
	if h := resp.Header.Get("X-Mndw-Echo"); h != "1" {
		t.Errorf("X-Mndw-Echo = %q, want 1", h)
	}
	got := decodeEcho(t, resp)
	if got.Method != "GET" || got.Query != "status=418" || got.PluginID != "backend-echo" || got.EndpointID != "echoGet" {
		t.Errorf("GET echo = %+v", got)
	}
	// The daemon defaults CONTENT_TYPE and reports a zero-length body for a GET.
	if got.ContentType != "application/json" || got.ContentLength != "0" {
		t.Errorf("GET echo contentType=%q contentLength=%q, want application/json / 0", got.ContentType, got.ContentLength)
	}

	// POST with a JSON body, echoed back verbatim.
	resp = do(t, http.MethodPost, srv.URL+"/api/plugins/backend-echo/echo", "", "application/json", []byte(`{"hi":1}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST = %d, want 200", resp.StatusCode)
	}
	got = decodeEcho(t, resp)
	if got.Method != "POST" || got.EndpointID != "echoPost" || got.Body != `{"hi":1}` {
		t.Errorf("POST echo = %+v", got)
	}
	if got.ContentType != "application/json" || got.ContentLength != "8" {
		t.Errorf("POST echo contentType=%q contentLength=%q, want application/json / 8", got.ContentType, got.ContentLength)
	}
}
