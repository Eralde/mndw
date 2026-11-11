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
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"terminal-page/internal/ttyd"
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

	t.Cleanup(func() { _ = server.manager.Shutdown(context.Background()) })

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

func TestTtydWebSocketURLUsesInjectedAddress(t *testing.T) {
	if url := ttydWebSocketURL("127.0.0.1:7681"); url != "ws://127.0.0.1:7681/" {
		t.Fatalf("ndmc websocket URL = %q, want root path", url)
	}

	if url := ttydWebSocketURL("127.0.0.1:7682"); url != "ws://127.0.0.1:7682/" {
		t.Fatalf("entware websocket URL = %q, want root path", url)
	}
}

func TestConsoleForRequestPrefersPathThenQueryThenRoute(t *testing.T) {
	tests := []struct {
		name    string
		target  string
		routeID string
		want    ttyd.Console
		wantOK  bool
	}{
		{name: "default", target: "/terminal", want: ttyd.ConsoleNDMC, wantOK: true},
		{name: "query ndmc", target: "/terminal?console=ndmc", want: ttyd.ConsoleNDMC, wantOK: true},
		{name: "query legacy router", target: "/terminal?console=router", want: ttyd.ConsoleNDMC, wantOK: true},
		{name: "query entware", target: "/terminal?console=entware", want: ttyd.ConsoleEntware, wantOK: true},
		{name: "entware path", target: "/terminal-entware", want: ttyd.ConsoleEntware, wantOK: true},
		{name: "entware path wins over query", target: "/terminal-entware?console=ndmc", want: ttyd.ConsoleEntware, wantOK: true},
		{name: "entware header fallback", target: "/terminal", routeID: "terminal-entware", want: ttyd.ConsoleEntware, wantOK: true},
		{name: "unknown query", target: "/terminal?console=serial", wantOK: false},
	}

	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, test.target, nil)
		if test.routeID != "" {
			request.Header.Set("X-Mndw-Route-Id", test.routeID)
		}

		got, ok := consoleForRequest(request)
		if ok != test.wantOK || got != test.want {
			t.Fatalf("%s: consoleForRequest() = (%q, %v), want (%q, %v)", test.name, got, ok, test.want, test.wantOK)
		}
	}
}

func testTTYDBinary(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "ttyd")
	script := "#!/bin/sh\ntrap 'exit 0' TERM\nwhile true; do sleep 1; done\n"

	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	return bin
}

func killRequest(server *Server, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/kill", strings.NewReader(body))
	response := httptest.NewRecorder()
	server.kill(response, request)

	return response
}

func TestKillLeavesConsoleRunningWhileConnectionsExist(t *testing.T) {
	server := newSpawnTestServer(t, testTTYDBinary(t))

	if err := server.manager.Start(context.Background(), ttyd.ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if !server.manager.Acquire(ttyd.ConsoleNDMC) {
		t.Fatal("Acquire() = false, want true")
	}

	response := killRequest(server, `{"console":"router"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("kill status = %d, want %d", response.Code, http.StatusOK)
	}

	if !server.manager.Running(ttyd.ConsoleNDMC) {
		t.Fatal("kill stopped a console with a live connection")
	}

	server.manager.Release(ttyd.ConsoleNDMC)
}

func TestKillStopsIdleConsole(t *testing.T) {
	server := newSpawnTestServer(t, testTTYDBinary(t))

	if err := server.manager.Start(context.Background(), ttyd.ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	response := killRequest(server, `{"console":"router"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("kill status = %d, want %d", response.Code, http.StatusOK)
	}

	if server.manager.Running(ttyd.ConsoleNDMC) {
		t.Fatal("kill left an idle console running")
	}
}

func TestKillWithoutConsoleIsNoOp(t *testing.T) {
	server := newSpawnTestServer(t, testTTYDBinary(t))
	ctx := context.Background()

	if err := server.manager.Start(ctx, ttyd.ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	if err := server.manager.Start(ctx, ttyd.ConsoleEntware); err != nil {
		t.Fatal(err)
	}

	response := killRequest(server, "")
	if response.Code != http.StatusOK {
		t.Fatalf("kill status = %d, want %d", response.Code, http.StatusOK)
	}

	if !server.manager.Running(ttyd.ConsoleNDMC) || !server.manager.Running(ttyd.ConsoleEntware) {
		t.Fatal("body-less kill stopped a console")
	}
}

func TestSpawnRejectsUnknownConsole(t *testing.T) {
	server := newSpawnTestServer(t, testTTYDBinary(t))
	request := httptest.NewRequest(http.MethodPost, "/spawn", strings.NewReader(`{"console":"serial"}`))
	response := httptest.NewRecorder()
	server.spawn(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("spawn status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

type serverTestTimer struct {
	clock    *serverTestClock
	duration time.Duration
	callback func()
	stopped  bool
}

func (timer *serverTestTimer) Stop() bool {
	timer.clock.mu.Lock()

	defer timer.clock.mu.Unlock()

	if timer.stopped {
		return false
	}

	timer.stopped = true

	return true
}

type serverTestClock struct {
	mu     sync.Mutex
	timers []*serverTestTimer
}

func (clock *serverTestClock) AfterFunc(duration time.Duration, callback func()) ttyd.Timer {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	timer := &serverTestTimer{clock: clock, duration: duration, callback: callback}
	clock.timers = append(clock.timers, timer)

	return timer
}

func (clock *serverTestClock) pending(duration time.Duration) int {
	clock.mu.Lock()

	defer clock.mu.Unlock()

	count := 0

	for _, timer := range clock.timers {
		if !timer.stopped && timer.duration == duration {
			count++
		}
	}

	return count
}

func useTestManager(server *Server, address string) *serverTestClock {
	clock := &serverTestClock{}

	server.manager = ttyd.NewManager(server.getenv, ttyd.ManagerOptions{
		AfterFunc: clock.AfterFunc,
		Address:   func(ttyd.Console) string { return address },
	})

	return clock
}

func echoWebSocketServer(t *testing.T) *httptest.Server {
	t.Helper()

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"tty"}})
		if err != nil {
			return
		}

		defer connection.CloseNow()

		for {
			typ, message, err := connection.Read(request.Context())
			if err != nil {
				return
			}

			if err := connection.Write(request.Context(), typ, message); err != nil {
				return
			}
		}
	}))

	t.Cleanup(upstream.Close)

	return upstream
}

func hostOf(server *httptest.Server) string {
	return strings.TrimPrefix(server.URL, "http://")
}

func dialBackendTerminal(t *testing.T, backend *httptest.Server, path string) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	connection, _, err := websocket.Dial(
		ctx,
		"ws"+strings.TrimPrefix(backend.URL, "http")+path,
		&websocket.DialOptions{Subprotocols: []string{"tty"}},
	)
	if err != nil {
		t.Fatalf("websocket.Dial(%s) error = %v", path, err)
	}

	return connection
}

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)

	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}

		time.Sleep(5 * time.Millisecond)
	}
}

func TestTerminalHandlerCountsConnectionsAndSchedulesGrace(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		console ttyd.Console
	}{
		{name: "ndmc route", path: "/terminal", console: ttyd.ConsoleNDMC},
		{name: "entware route", path: "/terminal-entware", console: ttyd.ConsoleEntware},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstream := echoWebSocketServer(t)
			server := newSpawnTestServer(t, testTTYDBinary(t))
			clock := useTestManager(server, hostOf(upstream))

			if err := server.manager.Start(context.Background(), test.console); err != nil {
				t.Fatal(err)
			}

			backend := httptest.NewServer(server.handler())

			t.Cleanup(backend.Close)

			client := dialBackendTerminal(t, backend, test.path)

			if got := server.manager.Connections(test.console); got != 1 {
				t.Fatalf("connections after dial = %d, want 1", got)
			}

			if err := client.Close(websocket.StatusNormalClosure, "done"); err != nil {
				t.Fatal(err)
			}

			waitFor(t, "connection release", func() bool {
				return server.manager.Connections(test.console) == 0
			})

			if pending := clock.pending(ttyd.GracePeriod); pending != 1 {
				t.Fatalf("pending grace timers = %d, want 1", pending)
			}
		})
	}
}

func TestTerminalHandlerDialFailureDoesNotCount(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	address := listener.Addr().String()

	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	server := newSpawnTestServer(t, testTTYDBinary(t))
	clock := useTestManager(server, address)

	if err := server.manager.Start(context.Background(), ttyd.ConsoleNDMC); err != nil {
		t.Fatal(err)
	}

	backend := httptest.NewServer(server.handler())

	t.Cleanup(backend.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	connection, _, err := websocket.Dial(
		ctx,
		"ws"+strings.TrimPrefix(backend.URL, "http")+"/terminal",
		&websocket.DialOptions{Subprotocols: []string{"tty"}},
	)
	if err == nil {
		connection.CloseNow()

		t.Fatal("websocket.Dial() succeeded with an unavailable ttyd")
	}

	if got := server.manager.Connections(ttyd.ConsoleNDMC); got != 0 {
		t.Fatalf("connections after failed dial = %d, want 0", got)
	}

	if pending := clock.pending(ttyd.GracePeriod); pending != 0 {
		t.Fatalf("pending grace timers = %d, want 0", pending)
	}
}
