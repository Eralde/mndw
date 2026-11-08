package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newSpawnTestServer(t *testing.T, ttydBin string) *Server {
	t.Helper()

	values := map[string]string{
		"MNDW_BACKEND_SOCKET": filepath.Join(t.TempDir(), "backend.sock"),
		"MNDW_TTYD_BIN":       ttydBin,
	}
	server, err := New(func(name string) string { return values[name] })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	return server
}

func captureBackendStderr(t *testing.T, run func()) string {
	t.Helper()

	file, err := os.CreateTemp(t.TempDir(), "backend-stderr-")
	if err != nil {
		t.Fatalf("CreateTemp() error = %v", err)
	}
	previous := os.Stderr
	os.Stderr = file
	run()
	os.Stderr = previous

	if err := file.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	contents, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	return string(contents)
}

func spawnRequest(server *Server) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/spawn", strings.NewReader(`{"console":"router"}`))
	response := httptest.NewRecorder()
	server.spawn(response, request)

	return response
}

func decodeSpawnError(t *testing.T, response *httptest.ResponseRecorder) (string, string) {
	t.Helper()

	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("Unmarshal() error = %v, body = %q", err, response.Body.String())
	}

	return body.Error, body.Message
}

func TestSpawnMissingTtydReturnsInstallErrorAndLogsUnderlyingError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-ttyd")
	server := newSpawnTestServer(t, missing)

	var response *httptest.ResponseRecorder
	stderr := captureBackendStderr(t, func() { response = spawnRequest(server) })

	if response.Code != http.StatusBadGateway {
		t.Fatalf("spawn status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	code, message := decodeSpawnError(t, response)
	if code != "TTYD_NOT_INSTALLED" || message != "ttyd is not installed" {
		t.Fatalf("spawn error = (%q, %q), want (TTYD_NOT_INSTALLED, ttyd is not installed)", code, message)
	}
	if !strings.Contains(stderr, missing) {
		t.Fatalf("backend stderr = %q, want underlying missing binary error containing %q", stderr, missing)
	}
}

func TestSpawnOtherTtydStartErrorKeepsGenericCodeAndLogsUnderlyingError(t *testing.T) {
	notExecutable := filepath.Join(t.TempDir(), "not-executable-ttyd")
	if err := os.WriteFile(notExecutable, []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := newSpawnTestServer(t, notExecutable)

	var response *httptest.ResponseRecorder
	stderr := captureBackendStderr(t, func() { response = spawnRequest(server) })

	if response.Code != http.StatusBadGateway {
		t.Fatalf("spawn status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	code, message := decodeSpawnError(t, response)
	if code != "TTYD_START_FAILED" || message != "failed to start terminal" {
		t.Fatalf("spawn error = (%q, %q), want (TTYD_START_FAILED, failed to start terminal)", code, message)
	}
	if !strings.Contains(stderr, notExecutable) || !strings.Contains(strings.ToLower(stderr), "permission") {
		t.Fatalf("backend stderr = %q, want underlying executable permission error", stderr)
	}
}

func TestWaitForTCPWaitsForLateListener(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)

	defer cancel()

	attempts := 0
	dial := func(context.Context, string) (net.Conn, error) {
		attempts++

		if attempts < 3 {
			return nil, errors.New("listener is not ready")
		}

		connection, peer := net.Pipe()
		_ = peer.Close()

		return connection, nil
	}

	if err := waitForTCPWithDial(ctx, "127.0.0.1:7681", dial); err != nil {
		t.Fatalf("waitForTCP() error = %v", err)
	}

	if attempts != 3 {
		t.Fatalf("dial attempts = %d, want 3", attempts)
	}
}

func TestTtydDialOptionsRequestTTYProtocol(t *testing.T) {
	options := ttydDialOptions()

	if len(options.Subprotocols) != 1 || options.Subprotocols[0] != "tty" {
		t.Fatalf("ttyd subprotocols = %#v, want [tty]", options.Subprotocols)
	}
}

func TestTtydWebSocketURLUsesRootPath(t *testing.T) {
	if url := ttydWebSocketURL(); url != "ws://127.0.0.1:7681/" {
		t.Fatalf("ttyd websocket URL = %q, want root path", url)
	}
}
