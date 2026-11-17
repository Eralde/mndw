package backend

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"mndwd/internal/httpx"
)

func TestServiceProxyAbortsDownstreamAfterPartialResponse(t *testing.T) {
	partial := bytes.Repeat([]byte("x"), 16<<10)
	socketPath := startProxyTestService(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", "20000")
		writer.WriteHeader(http.StatusOK)

		_, _ = writer.Write(partial)
	}))

	var logs bytes.Buffer
	gateway := proxyTestGateway(t, socketPath, slog.New(slog.NewTextHandler(&logs, nil)))
	frontDoor := httptest.NewServer(gateway)

	t.Cleanup(frontDoor.Close)

	response, err := frontDoor.Client().Get(frontDoor.URL + "/api/plugins/demo/health")
	if err != nil {
		t.Fatalf("GET service route: %v", err)
	}

	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err == nil {
		t.Fatal("reading truncated service response succeeded")
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
	}

	if len(body) == 0 {
		t.Fatal("client received no partial response body")
	}

	if bytes.Contains(body, []byte(`"error"`)) {
		t.Fatalf("partial response contains appended JSON error: %q", body)
	}

	if !strings.Contains(logs.String(), "service proxy response aborted") {
		t.Fatalf("abort was not logged: %q", logs.String())
	}

	if strings.Contains(logs.String(), string(partial)) {
		t.Fatal("proxy log contains response body")
	}
}

func TestServiceProxyReturnsBadGatewayBeforeResponseCommit(t *testing.T) {
	socketPath := shortUnixSocketPath(t, "missing.sock")
	gateway := proxyTestGateway(t, socketPath, nil)
	frontDoor := httptest.NewServer(gateway)

	t.Cleanup(frontDoor.Close)

	response, err := frontDoor.Client().Get(frontDoor.URL + "/api/plugins/demo/health")
	if err != nil {
		t.Fatalf("GET service route: %v", err)
	}

	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read gateway error response: %v", err)
	}

	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadGateway)
	}

	if got := response.Header.Get(httpx.HeaderErrorMarker); got != "1" {
		t.Fatalf("%s = %q, want 1", httpx.HeaderErrorMarker, got)
	}

	if !bytes.Contains(body, []byte(`"error"`)) || !bytes.Contains(body, []byte(httpx.CodeBadGateway)) {
		t.Fatalf("body = %q, want 502 JSON error envelope", body)
	}
}

func TestServiceProxyStripsPluginErrorMarker(t *testing.T) {
	socketPath := startProxyTestService(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set(httpx.HeaderErrorMarker, "1")
		writer.WriteHeader(http.StatusUnprocessableEntity)

		_, _ = io.WriteString(writer, `{"error":{"code":"BAD_REQUEST"}}`)
	}))
	gateway := proxyTestGateway(t, socketPath, nil)
	frontDoor := httptest.NewServer(gateway)

	t.Cleanup(frontDoor.Close)

	response, err := frontDoor.Client().Get(frontDoor.URL + "/api/plugins/demo/health")
	if err != nil {
		t.Fatalf("GET service route: %v", err)
	}

	defer response.Body.Close()

	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnprocessableEntity)
	}

	if got := response.Header.Get(httpx.HeaderErrorMarker); got != "" {
		t.Fatalf("plugin %s = %q, want absent", httpx.HeaderErrorMarker, got)
	}
}

func TestWebSocketUpgradeDoesNotForwardPluginErrorMarker(t *testing.T) {
	socketPath := startProxyTestService(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set(httpx.HeaderErrorMarker, "1")

		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{})
		if err != nil {
			return
		}

		_ = connection.Close(websocket.StatusNormalClosure, "")
	}))
	gateway := proxyTestGateway(t, socketPath, nil)
	frontDoor := httptest.NewServer(gateway)

	t.Cleanup(frontDoor.Close)

	connection, response, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(frontDoor.URL, "http")+"/ws/plugins/demo/terminal", &websocket.DialOptions{
		Subprotocols: []string{"tty"},
	})
	if err != nil {
		var body []byte

		if response != nil && response.Body != nil {
			body, _ = io.ReadAll(response.Body)
		}

		t.Fatalf("dial plugin websocket route: %v (response %v, body %q)", err, response, body)
	}

	defer connection.CloseNow()

	if got := response.Header.Get(httpx.HeaderErrorMarker); got != "" {
		t.Fatalf("plugin websocket %s = %q, want absent", httpx.HeaderErrorMarker, got)
	}
}

func TestWebSocketGatewayErrorIsMarked(t *testing.T) {
	socketPath := shortUnixSocketPath(t, "missing.sock")
	gateway := proxyTestGateway(t, socketPath, nil)
	frontDoor := httptest.NewServer(gateway)

	t.Cleanup(frontDoor.Close)

	_, response, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(frontDoor.URL, "http")+"/ws/plugins/demo/terminal", &websocket.DialOptions{
		Subprotocols: []string{"tty"},
	})
	if err == nil {
		t.Fatal("dial unavailable plugin websocket succeeded")
	}

	if response == nil {
		t.Fatalf("dial unavailable plugin websocket: %v (no HTTP response)", err)
	}

	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadGateway)
	}

	if got := response.Header.Get(httpx.HeaderErrorMarker); got != "1" {
		t.Fatalf("%s = %q, want 1", httpx.HeaderErrorMarker, got)
	}
}

func proxyTestGateway(t *testing.T, socketPath string, logger *slog.Logger) http.Handler {
	t.Helper()

	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})

	setSupervisorServiceRecordForTest(runtime.supervisor, "demo", &serviceRecord{
		paths:  RuntimePaths{BackendSocket: socketPath},
		status: RuntimeStatus{State: StateReady},
	})

	gateway := newPreludeGateway(t, authPass(), runtime)
	gateway.logger = logger

	mux := http.NewServeMux()

	gateway.Register(mux)

	return mux
}

func startProxyTestService(t *testing.T, handler http.Handler) string {
	t.Helper()

	socketPath := shortUnixSocketPath(t, "backend.sock")
	listener := listenUnixForTest(t, socketPath)
	server := &http.Server{Handler: handler}

	go func() { _ = server.Serve(listener) }()

	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
	})

	return socketPath
}

func TestServiceRequestHeadersUseAllowlist(t *testing.T) {
	request, err := http.NewRequest(http.MethodPost, "http://mndw/status?q=1", nil)
	if err != nil {
		t.Fatal(err)
	}

	request.Header.Set("Cookie", "secret")
	request.Header.Set("Authorization", "secret")
	request.Header.Set("X-Mndw-Csrf", "1")
	request.Header.Set("Content-Type", "application/json")

	filtered := filteredServiceHeaders(request.Header)

	if filtered.Get("Cookie") != "" || filtered.Get("Authorization") != "" || filtered.Get("X-Mndw-Csrf") != "" {
		t.Fatalf("sensitive headers survived: %#v", filtered)
	}

	if filtered.Get("Content-Type") != "application/json" {
		t.Fatalf("content type removed: %#v", filtered)
	}
}
