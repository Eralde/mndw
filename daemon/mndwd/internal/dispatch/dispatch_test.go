package dispatch

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

// allowAuth / denyAuth stub the session gate.
type allowAuth struct{}

func (allowAuth) Authenticate(*http.Request) *httpx.APIError { return nil }

type denyAuth struct{}

func (denyAuth) Authenticate(*http.Request) *httpx.APIError {
	return httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "no session")
}

// harness wires a registry over a temp user-plugins dir + state store and a dispatch
// handler behind an httptest server.
type harness struct {
	srv     *httptest.Server
	store   *state.Store
	userDir string
}

func newHarness(t *testing.T, auth Authenticator, cfg Config) *harness {
	t.Helper()
	root := t.TempDir()
	userDir := filepath.Join(root, "user-plugins")
	store, err := state.Open(filepath.Join(root, "data", "state.json"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	reg := registry.New(store, userDir, filepath.Join(root, "builtin"))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	New(cfg, reg, auth, logger).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return &harness{srv: srv, store: store, userDir: userDir}
}

// install writes a plugin's manifest + files to disk and records it in state with the
// given approval/enabled.
func (h *harness) install(t *testing.T, name, manifestJSON string, files map[string]string, approval string, enabled bool) {
	t.Helper()
	dir := filepath.Join(h.userDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for rel, content := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o644)
		if strings.HasSuffix(rel, ".sh") {
			mode = 0o755
		}
		if err := os.WriteFile(p, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}

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

func manifestJSON(name string, extra string) string {
	return `{
  "manifestVersion": 2, "name": "` + name + `", "version": "1.0.0",
  "type": "widget", "label": "Svc", "entry": "index.js",
  "size": {"w": 4, "h": 3},
  "backend": {` + extra + `}
}`
}

// standard backend: GET run.sh at path "run", POST echo.sh at path "echo".
const stdBackend = `
    "scripts": [
      {"id": "s1", "source": "backend/run.sh", "runtime": "sh"},
      {"id": "s2", "source": "backend/echo.sh", "runtime": "sh"}
    ],
    "endpoints": [
      {"id": "e1", "method": "GET", "path": "run", "scriptId": "s1"},
      {"id": "e2", "method": "POST", "path": "echo", "scriptId": "s2"}
    ]`

const secureBackend = `
    "scripts": [
      {"id": "s1", "source": "backend/run.sh", "runtime": "sh"},
      {"id": "s2", "source": "backend/echo.sh", "runtime": "sh"}
    ],
    "endpoints": [
      {"id": "e1", "method": "GET", "path": "run", "scriptId": "s1", "sensitive": true},
      {"id": "e2", "method": "POST", "path": "echo", "scriptId": "s2", "csrf": true, "sensitive": true}
    ]`

const runScript = `#!/bin/sh
echo "Status: 200"
echo "Content-Type: application/json"
echo ""
printf '{"method":"%s","query":"%s","plugin":"%s","endpoint":"%s"}' \
  "$REQUEST_METHOD" "$QUERY_STRING" "$MNDW_PLUGIN_ID" "$MNDW_ENDPOINT_ID"
`

const echoScript = `#!/bin/sh
body=$(cat)
echo "Status: 200"
echo "Content-Type: text/plain"
echo ""
printf '%s' "$body"
`

func stdFiles() map[string]string {
	return map[string]string{
		"index.js":        "export function createInstance(){}",
		"backend/run.sh":  runScript,
		"backend/echo.sh": echoScript,
	}
}

func codeOf(t *testing.T, resp *http.Response) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}

	return env.Error.Code
}

func TestDispatchExecutesScriptWithCGIEnv(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run?foo=bar")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q, want application/json", ct)
	}

	var got struct {
		Method   string `json:"method"`
		Query    string `json:"query"`
		Plugin   string `json:"plugin"`
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if got.Method != "GET" || got.Query != "foo=bar" || got.Plugin != "svc" || got.Endpoint != "e1" {
		t.Errorf("CGI env not propagated: %+v", got)
	}
}

func TestDispatchInjectsPrivatePluginRuntimeDir(t *testing.T) {
	runtimeRoot := t.TempDir()
	h := newHarness(t, allowAuth{}, Config{PluginRuntimeRoot: runtimeRoot})
	files := map[string]string{
		"index.js": "x",
		"backend/run.sh": `#!/bin/sh
printf 'Status: 200\r\nContent-Type: text/plain\r\n\r\n%s\n' "$MNDW_PLUGIN_RUNTIME_DIR"
`,
	}
	h.install(t, "svc", manifestJSON("svc", `
    "scripts": [{"id": "s1", "source": "backend/run.sh", "runtime": "sh"}],
    "endpoints": [{"id": "e1", "method": "GET", "path": "run", "scriptId": "s1"}]`), files, state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.TrimSpace(string(body)), filepath.Join(runtimeRoot, "svc"); got != want {
		t.Fatalf("runtime dir = %q, want %q", got, want)
	}
	info, err := os.Stat(filepath.Join(runtimeRoot, "svc"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Fatalf("runtime dir mode = %o, want 700", mode)
	}
}

func TestDispatchPostBodyOnStdin(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, true)

	resp, err := http.Post(h.srv.URL+"/api/plugins/svc/echo", "text/plain", strings.NewReader("hello stdin"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello stdin" {
		t.Errorf("body = %q, want %q", body, "hello stdin")
	}
}

func TestDispatchUnknownPluginRoute(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})

	resp, err := http.Get(h.srv.URL + "/api/plugins/ghost/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "ROUTE_NOT_FOUND" {
		t.Errorf("code = %s, want ROUTE_NOT_FOUND", c)
	}
}

func TestDispatchMethodMismatchIsNotFound(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, true)

	// "run" is GET-only; POST to it must not match.
	resp, err := http.Post(h.srv.URL+"/api/plugins/svc/run", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "ROUTE_NOT_FOUND" {
		t.Errorf("code = %s, want ROUTE_NOT_FOUND", c)
	}
}

func TestDispatchNotApproved(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalPending, false)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "NOT_APPROVED" {
		t.Errorf("code = %s, want NOT_APPROVED", c)
	}
}

func TestDispatchDisabled(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, false)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "DISABLED" {
		t.Errorf("code = %s, want DISABLED", c)
	}
}

func TestDispatchScriptFailure(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{Dev: true})
	files := map[string]string{
		"index.js":        "x",
		"backend/run.sh":  "#!/bin/sh\necho boom >&2\nexit 3\n",
		"backend/echo.sh": echoScript,
	}
	h.install(t, "svc", manifestJSON("svc", stdBackend), files, state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}

	var env struct {
		Error struct {
			Code   string            `json:"code"`
			Detail map[string]string `json:"detail"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatal(err)
	}
	if env.Error.Code != "SCRIPT_FAILED" {
		t.Errorf("code = %s, want SCRIPT_FAILED", env.Error.Code)
	}
	// --dev surfaces the stderr tail.
	if !strings.Contains(env.Error.Detail["stderr"], "boom") {
		t.Errorf("dev detail should include stderr, got %v", env.Error.Detail)
	}
}

func TestDispatchTimeout(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{Timeout: 150 * time.Millisecond})
	files := map[string]string{
		"index.js":        "x",
		"backend/run.sh":  "#!/bin/sh\nsleep 3\necho done\n",
		"backend/echo.sh": echoScript,
	}
	h.install(t, "svc", manifestJSON("svc", stdBackend), files, state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "SCRIPT_TIMEOUT" {
		t.Errorf("code = %s, want SCRIPT_TIMEOUT", c)
	}
}

func TestDispatchTimeoutKillsScriptDescendants(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{Timeout: 500 * time.Millisecond})
	files := map[string]string{
		"index.js": "x",
		"backend/run.sh": `#!/bin/sh
sleep 5 &
echo $! > child.pid
wait
`,
		"backend/echo.sh": echoScript,
	}
	h.install(t, "svc", manifestJSON("svc", stdBackend), files, state.ApprovalApproved, true)

	started := time.Now()
	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatalf("request should return a timeout response: %v", err)
	}
	defer resp.Body.Close()
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("timeout response took %s; descendant kept command pipes open", elapsed)
	}

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "SCRIPT_TIMEOUT" {
		t.Errorf("code = %s, want SCRIPT_TIMEOUT", c)
	}

	pidData, err := os.ReadFile(filepath.Join(h.userDir, "svc", "child.pid"))
	if err != nil {
		t.Fatalf("read child pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil {
		t.Fatalf("parse child pid: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })

	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatalf("timed-out script descendant pid %d is still running", pid)
	}
}

func TestDispatchSessionGate(t *testing.T) {
	h := newHarness(t, denyAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, true)

	// Non-public plugin behind denyAuth → 401.
	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "UNAUTHORIZED" {
		t.Errorf("code = %s, want UNAUTHORIZED", c)
	}
}

func TestDispatchCsrfIsEnforcedAfterSessionGate(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", secureBackend), stdFiles(), state.ApprovalApproved, true)

	resp, err := http.Post(h.srv.URL+"/api/plugins/svc/echo", "text/plain", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "CSRF_REQUIRED" {
		t.Errorf("code = %s, want CSRF_REQUIRED", c)
	}
}

func TestDispatchSensitiveSuccessSetsNoStore(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{})
	h.install(t, "svc", manifestJSON("svc", secureBackend), stdFiles(), state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want no-referrer", got)
	}
}

func TestDispatchUnknownRouteGatedBeforeExistenceLeak(t *testing.T) {
	// Unauthenticated probe of a non-existent route must be rejected by the session
	// gate (401), not reveal via 404 whether the route exists.
	h := newHarness(t, denyAuth{}, Config{})

	resp, err := http.Get(h.srv.URL + "/api/plugins/ghost/whatever")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (gate before existence leak)", resp.StatusCode)
	}
}

func TestDispatchPublicSkipsSessionGate(t *testing.T) {
	h := newHarness(t, denyAuth{}, Config{})
	// public backend: same scripts, plus "public": true.
	extra := `"public": true,` + stdBackend
	h.install(t, "pub", manifestJSON("pub", extra), stdFiles(), state.ApprovalApproved, true)

	resp, err := http.Get(h.srv.URL + "/api/plugins/pub/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("public route status = %d, want 200 (session gate skipped)", resp.StatusCode)
	}
}

func TestDispatchBodyTooLarge(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{MaxRequestBytes: 16})
	h.install(t, "svc", manifestJSON("svc", stdBackend), stdFiles(), state.ApprovalApproved, true)

	big := strings.Repeat("A", 1024)
	resp, err := http.Post(h.srv.URL+"/api/plugins/svc/echo", "text/plain", strings.NewReader(big))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "BODY_TOO_LARGE" {
		t.Errorf("code = %s, want BODY_TOO_LARGE", c)
	}
}

func TestDispatchConcurrencyCap(t *testing.T) {
	h := newHarness(t, allowAuth{}, Config{MaxConcurrentExec: 1})
	// Script signals it has started (creates a marker in cwd) then sleeps, holding
	// the single slot so a second request is rejected deterministically.
	files := map[string]string{
		"index.js":        "x",
		"backend/run.sh":  "#!/bin/sh\ntouch started.marker\nsleep 2\necho ok\n",
		"backend/echo.sh": echoScript,
	}
	h.install(t, "svc", manifestJSON("svc", stdBackend), files, state.ApprovalApproved, true)

	firstDone := make(chan int, 1)
	go func() {
		resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
		if err != nil {
			firstDone <- 0

			return
		}
		defer resp.Body.Close()
		firstDone <- resp.StatusCode
	}()

	// Wait until the first script is actually running (slot held).
	marker := filepath.Join(h.userDir, "svc", "started.marker")
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first script never started")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Second concurrent request → rejected.
	resp, err := http.Get(h.srv.URL + "/api/plugins/svc/run")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second request status = %d, want 429", resp.StatusCode)
	}
	if c := codeOf(t, resp); c != "TOO_MANY_REQUESTS" {
		t.Errorf("code = %s, want TOO_MANY_REQUESTS", c)
	}

	if got := <-firstDone; got != http.StatusOK {
		t.Errorf("first request status = %d, want 200", got)
	}
}

func TestParseCGIResponse(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		wantStatus int
		wantCT     string
		wantBody   string
	}{
		{"headers and body", "Status: 201\nContent-Type: text/plain\n\nhi", 201, "text/plain", "hi"},
		{"crlf separator", "Status: 200\r\nContent-Type: application/json\r\n\r\n{}", 200, "application/json", "{}"},
		{"status with reason", "Status: 404 Not Found\n\nnope", 404, "", "nope"},
		{"no headers plain json", `{"ok":true}`, 200, "", `{"ok":true}`},
		{"json with colon and blank line not misparsed", "{\"a\":1}\n\nmore", 200, "", "{\"a\":1}\n\nmore"},
		{"bad status falls back to 200", "Status: notanumber\n\nbody", 200, "", "body"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, header, body := parseCGIResponse([]byte(tc.in))
			if status != tc.wantStatus {
				t.Errorf("status = %d, want %d", status, tc.wantStatus)
			}
			if got := header.Get("Content-Type"); got != tc.wantCT {
				t.Errorf("content-type = %q, want %q", got, tc.wantCT)
			}
			if !bytes.Equal(body, []byte(tc.wantBody)) {
				t.Errorf("body = %q, want %q", body, tc.wantBody)
			}
		})
	}
}
