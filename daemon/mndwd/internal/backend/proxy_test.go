package backend

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	if !bytes.Contains(body, []byte(`"error"`)) || !bytes.Contains(body, []byte(httpx.CodeBadGateway)) {
		t.Fatalf("body = %q, want 502 JSON error envelope", body)
	}
}

func proxyTestGateway(t *testing.T, socketPath string, logger *slog.Logger) http.Handler {
	t.Helper()

	runtime := NewRuntime(RuntimeConfig{RuntimeRoot: t.TempDir()})
	runtime.supervisor.services["demo"] = &serviceRecord{
		paths:  RuntimePaths{BackendSocket: socketPath},
		status: RuntimeStatus{State: StateReady},
	}
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
