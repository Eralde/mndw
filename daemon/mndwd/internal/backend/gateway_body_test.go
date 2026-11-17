package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mndwd/internal/httpx"
	"mndwd/internal/manifest"
	"mndwd/internal/registry"
	"mndwd/internal/state"
)

const execBodyManifest = `{"manifestVersion":1,"name":"demo","version":"1.0.0","type":"page","label":"Demo","entry":"index.js","route":"/demo","backend":{"kind":"exec","routes":[{"id":"get","transport":"http","method":"GET","path":"get","command":"backend/command.sh","access":"public"},{"id":"head","transport":"http","method":"HEAD","path":"get","command":"backend/command.sh","access":"public"},{"id":"post","transport":"http","method":"POST","path":"post","command":"backend/command.sh"}]}}`

func TestGatewayBodyReadTimeoutDefault(t *testing.T) {
	if got := NewGateway(GatewayConfig{}, nil, nil, nil, nil).cfg.BodyReadTimeout; got != 15*time.Second {
		t.Fatalf("body read timeout = %s, want 15s", got)
	}
}

func TestGatewayExecWithoutRunnerReturnsInternal(t *testing.T) {
	gateway := NewGateway(GatewayConfig{}, nil, nil, &RuntimeImpl{}, nil)
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	recorder := httptest.NewRecorder()

	gateway.serveExec(recorder, request, &registry.Plugin{Name: "demo"}, manifest.BackendRoute{})

	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}

	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}

	if recorder.Code != http.StatusInternalServerError || payload.Error.Code != httpx.CodeInternal || payload.Error.Message != "exec backend is not configured" {
		t.Fatalf("response = %d %#v, want 500 INTERNAL exec backend is not configured", recorder.Code, payload.Error)
	}
}

func TestGatewayExecStripsPluginErrorMarkerAndMarksDaemonError(t *testing.T) {
	server, pluginDir, _ := newExecBodyTestServer(t, GatewayConfig{}, Limits{})
	command := "#!/bin/sh\ncase \"$QUERY_STRING\" in fail) exit 1;; esac\nprintf 'Status: 422 Unprocessable Entity\\r\\nX-mndw-errOR: 1\\r\\nContent-Type: application/json\\r\\n\\r\\n{\\\"error\\\":{\\\"code\\\":\\\"BAD_REQUEST\\\"}}'\n"

	if err := os.WriteFile(filepath.Join(pluginDir, "backend", "command.sh"), []byte(command), 0o700); err != nil {
		t.Fatal(err)
	}

	defer server.Close()

	pluginResponse, err := server.Client().Get(server.URL + "/api/plugins/demo/get")
	if err != nil {
		t.Fatalf("GET plugin response: %v", err)
	}

	_ = pluginResponse.Body.Close()

	if pluginResponse.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("plugin status = %d, want %d", pluginResponse.StatusCode, http.StatusUnprocessableEntity)
	}

	if got := pluginResponse.Header.Get(httpx.HeaderErrorMarker); got != "" {
		t.Fatalf("plugin %s = %q, want absent", httpx.HeaderErrorMarker, got)
	}

	daemonResponse, err := server.Client().Get(server.URL + "/api/plugins/demo/get?fail")
	if err != nil {
		t.Fatalf("GET daemon error response: %v", err)
	}

	_ = daemonResponse.Body.Close()

	if daemonResponse.StatusCode != http.StatusBadGateway {
		t.Fatalf("daemon status = %d, want %d", daemonResponse.StatusCode, http.StatusBadGateway)
	}

	if got := daemonResponse.Header.Get(httpx.HeaderErrorMarker); got != "1" {
		t.Fatalf("daemon %s = %q, want 1", httpx.HeaderErrorMarker, got)
	}
}

func TestGatewayExecRejectsGETBodyBeforeRunningCommand(t *testing.T) {
	server, pluginDir, _ := newExecBodyTestServer(t, GatewayConfig{}, Limits{})

	defer server.Close()

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request, err := http.NewRequest(method, server.URL+"/api/plugins/demo/get", strings.NewReader("body"))
		if err != nil {
			t.Fatal(err)
		}

		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}

		if response.StatusCode != http.StatusBadRequest {
			payload, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()

			t.Fatalf("%s status = %d, want 400; body = %s", method, response.StatusCode, payload)
		}

		_ = response.Body.Close()
	}

	if _, err := os.Stat(filepath.Join(pluginDir, "ran")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("command marker stat error = %v, want not-exist", err)
	}
}

func TestGatewayExecAdmissionPrecedesBodyRead(t *testing.T) {
	handler, _, runtime := newExecBodyTestHandler(t, GatewayConfig{}, Limits{MaxConcurrentExecTotal: 1, MaxConcurrentExecPerPlugin: 1})

	reservation, admitted := runtime.TryAcquireExec("demo")

	if !admitted {
		t.Fatal("test could not occupy the exec slot")
	}

	defer reservation.Release()

	request := httptest.NewRequest(http.MethodPost, "/api/plugins/demo/post", nil)
	request.ContentLength = 10

	request.Header.Set("X-Mndw-Csrf", "1")

	body := &recordingRequestBody{}
	request.Body = body
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body = %s", recorder.Code, recorder.Body.String())
	}

	if body.reads != 0 {
		t.Fatalf("request body read %d times with full exec pool, want no reads", body.reads)
	}
}

func TestGatewayExecOversizedBodyUsesBackendCode(t *testing.T) {
	server, pluginDir, _ := newExecBodyTestServer(t, GatewayConfig{MaxRequestBytes: 4}, Limits{})

	defer server.Close()

	response := postExecBody(t, server, "oversize")

	defer response.Body.Close()

	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusRequestEntityTooLarge || payload.Error.Code != CodeBackendBodyTooLarge {
		t.Fatalf("oversize response = %d %q, want 413 %q", response.StatusCode, payload.Error.Code, CodeBackendBodyTooLarge)
	}

	if _, err := os.Stat(filepath.Join(pluginDir, "ran")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("command marker stat error = %v, want not-exist", err)
	}
}

type recordingRequestBody struct {
	reads int
}

func (body *recordingRequestBody) Read([]byte) (int, error) {
	body.reads++

	return 0, io.EOF
}

func (*recordingRequestBody) Close() error { return nil }

func TestGatewayExecSlowBodyTimesOutAndReleasesAdmission(t *testing.T) {
	server, pluginDir, _ := newExecBodyTestServer(t, GatewayConfig{BodyReadTimeout: 80 * time.Millisecond}, Limits{})

	defer server.Close()

	response := sendPartialBodyRequest(t, server, http.MethodPost, "/api/plugins/demo/post", 10, "x", time.Second)

	if response.Body != nil {
		defer response.Body.Close()
	}

	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusRequestTimeout || payload.Error.Code != httpx.CodeRequestTimeout {
		t.Fatalf("timeout response = %d %q, want 408 %q", response.StatusCode, payload.Error.Code, httpx.CodeRequestTimeout)
	}

	if _, err := os.Stat(filepath.Join(pluginDir, "ran")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("command marker stat error = %v, want not-exist", err)
	}

	response = postExecBody(t, server, "body")

	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("following admitted request status = %d, want 200", response.StatusCode)
	}
}

func TestGatewayExecBodyTimeoutDoesNotCancelLongerCommand(t *testing.T) {
	server, pluginDir, _ := newExecBodyTestServer(t, GatewayConfig{BodyReadTimeout: 50 * time.Millisecond}, Limits{})

	defer server.Close()

	command := "#!/bin/sh\ntouch \"$MNDW_PLUGIN_DIR/ran\"\nsleep 0.2\nprintf 'Content-Type: text/plain\\r\\n\\r\\nran'\n"

	if err := os.WriteFile(filepath.Join(pluginDir, "backend", "command.sh"), []byte(command), 0o700); err != nil {
		t.Fatal(err)
	}

	response := postExecBody(t, server, "body")

	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("longer command status = %d, want 200", response.StatusCode)
	}
}

func postExecBody(t *testing.T, server *httptest.Server, body string) *http.Response {
	t.Helper()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/plugins/demo/post", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	request.Header.Set("X-Mndw-Csrf", "1")

	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	return response
}

func newExecBodyTestServer(t *testing.T, gatewayConfig GatewayConfig, limits Limits) (*httptest.Server, string, *RuntimeImpl) {
	t.Helper()

	handler, pluginDir, runtime := newExecBodyTestHandler(t, gatewayConfig, limits)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on IPv4 loopback: %v", err)
	}

	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}

	server.Start()
	t.Cleanup(server.Close)

	return server, pluginDir, runtime
}

func newExecBodyTestHandler(t *testing.T, gatewayConfig GatewayConfig, limits Limits) (http.Handler, string, *RuntimeImpl) {
	t.Helper()

	root := t.TempDir()
	userDir := filepath.Join(root, "plugins")
	pluginDir := filepath.Join(userDir, "demo")
	commandDir := filepath.Join(pluginDir, "backend")

	if err := os.MkdirAll(commandDir, 0o700); err != nil {
		t.Fatal(err)
	}

	command := "#!/bin/sh\ntouch \"$MNDW_PLUGIN_DIR/ran\"\nprintf 'Content-Type: text/plain\\r\\n\\r\\nran'\n"

	if err := os.WriteFile(filepath.Join(commandDir, "command.sh"), []byte(command), 0o700); err != nil {
		t.Fatal(err)
	}

	store, err := state.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Mutate(func(st *state.State) error {
		st.Plugins["demo"] = &state.Plugin{
			Name:     "demo",
			Source:   state.SourceUpload,
			Version:  "1.0.0",
			Type:     "page",
			Label:    "Demo",
			Approval: state.ApprovalApproved,
			Enabled:  true,
			Manifest: json.RawMessage(execBodyManifest),
		}

		return nil
	}); err != nil {
		t.Fatal(err)
	}

	reg := registry.NewWithLogger(store, userDir, "", nil)
	runtime := NewRuntime(RuntimeConfig{
		RuntimeRoot: t.TempDir(),
		Limits:      limits,
		Exec:        ExecRunnerConfig{Timeout: 2 * time.Second, KillGrace: 100 * time.Millisecond},
	})

	t.Cleanup(func() {
		if err := runtime.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown runtime: %v", err)
		}
	})

	mux := http.NewServeMux()

	NewGateway(gatewayConfig, reg, nil, runtime, nil).Register(mux)

	return mux, pluginDir, runtime
}

func sendPartialBodyRequest(t *testing.T, server *httptest.Server, method, path string, contentLength int, initialBody string, timeout time.Duration) *http.Response {
	t.Helper()

	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}

	if _, err := fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: %s\r\nX-Mndw-Csrf: 1\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", method, path, server.Listener.Addr().String(), contentLength, initialBody); err != nil {
		t.Fatal(err)
	}

	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: method})

	if err != nil {
		t.Fatalf("read response: %v", err)
	}

	return response
}
