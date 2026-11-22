package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"iperf-widget/internal/session"
)

func TestSocketCloseStops(t *testing.T) {
	manager := newHTTPTestManager(t)
	server, err := New(manager)
	if err != nil {
		t.Fatal(err)
	}

	web := httptest.NewServer(server.handler())

	defer web.Close()

	listener, host, port := listenForProbe(t)

	defer listener.Close()

	request := map[string]any{"type": "start", "host": host, "portFrom": port, "portTo": port, "duration": 5, "streams": 1}

	first := dialTestSocket(t, web.URL)

	writeMessage(t, first, request)
	waitForSocketType(t, first, "interval")

	_ = first.CloseNow()

	second := dialTestSocket(t, web.URL)

	defer second.CloseNow()

	for {
		writeMessage(t, second, request)

		message := readMessage(t, second)

		if message["type"] == "error" && message["code"] == "busy" {
			continue
		}

		if message["type"] == "done" {
			return
		}
	}
}

func TestInvalidStartReturnsTypedError(t *testing.T) {
	server, err := New(newHTTPTestManager(t))
	if err != nil {
		t.Fatal(err)
	}

	web := httptest.NewServer(server.handler())

	defer web.Close()

	connection := dialTestSocket(t, web.URL)

	defer connection.CloseNow()

	writeMessage(t, connection, map[string]any{"type": "start", "host": "http://x", "portFrom": 5201, "portTo": 5201, "duration": 10, "streams": 4})

	message := readMessage(t, connection)

	if message["type"] != "error" || message["code"] != "invalid-input" {
		t.Fatalf("message = %#v, want invalid-input error", message)
	}
}

func TestReady(t *testing.T) {
	server, err := New(newHTTPTestManager(t))
	if err != nil {
		t.Fatal(err)
	}

	web := httptest.NewServer(server.handler())

	defer web.Close()

	response, err := http.Get(web.URL + "/_mndw/ready")
	if err != nil {
		t.Fatal(err)
	}

	defer response.Body.Close()

	var body map[string]any

	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusOK || body["protocolVersion"] != float64(1) {
		t.Fatalf("ready response = %d %#v, want protocolVersion 1", response.StatusCode, body)
	}
}

func TestPingSampleFailureEncodesNull(t *testing.T) {
	data, err := json.Marshal(session.Message{Type: "pingSample", Index: 4})
	if err != nil {
		t.Fatal(err)
	}

	var message map[string]any

	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}

	_, hasMS := message["ms"]

	if message["type"] != "pingSample" || message["index"] != float64(4) || !hasMS || message["ms"] != nil {
		t.Fatalf("encoded sample = %s, want failed sample with ms:null", data)
	}
}

func TestPingFailureSummaryEncodesNull(t *testing.T) {
	data, err := json.Marshal(session.Message{Type: "ping"})
	if err != nil {
		t.Fatal(err)
	}

	var message map[string]any

	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}

	pingMs, hasPingMs := message["pingMs"]
	jitterMs, hasJitterMs := message["jitterMs"]

	if message["type"] != "ping" || !hasPingMs || pingMs != nil || !hasJitterMs || jitterMs != nil {
		t.Fatalf("encoded summary = %s, want pingMs:null and jitterMs:null", data)
	}
}

func TestServerRunWaitsForRun(t *testing.T) {
	manager := newHTTPTestManager(t)
	socketPath := os.Getenv("MNDW_BACKEND_SOCKET")
	pidFile := filepath.Join(t.TempDir(), "child.pid")

	t.Setenv("IPERF_PID_FILE", pidFile)

	server, err := New(manager)
	if err != nil {
		t.Fatal(err)
	}

	rootContext, cancelRoot := context.WithCancel(context.Background())
	serverDone := make(chan error, 1)

	go func() {
		serverDone <- server.Run(rootContext)
	}()

	serverFinished := false

	defer func() {
		cancelRoot()

		if !serverFinished {
			select {
			case <-serverDone:
			case <-time.After(5 * time.Second):
			}
		}
	}()

	waitForUnixSocket(t, socketPath)

	connection := dialUnixTestSocket(t, socketPath)

	defer connection.CloseNow()

	listener, host, port := listenForProbe(t)

	defer listener.Close()

	writeMessage(t, connection, map[string]any{
		"type": "start", "host": host, "portFrom": port, "portTo": port, "duration": 5, "streams": 1,
	})
	waitForSocketType(t, connection, "interval")

	pidBytes, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	if err != nil {
		t.Fatal(err)
	}

	cancelRoot()

	select {
	case err := <-serverDone:
		serverFinished = true

		if err != nil {
			t.Fatalf("Server.Run() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Server.Run() did not finish after cancellation")
	}

	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child pid %d still exists after Server.Run returned: %v", pid, err)
	}
}

func TestReadResultSendUnblocksOnCancellation(t *testing.T) {
	connectionContext, cancel := context.WithCancel(context.Background())
	reads := make(chan readResult, 1)
	reads <- readResult{}
	done := make(chan struct{})

	go func() {
		defer close(done)

		sendReadResult(connectionContext, reads, readResult{})
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("reader send did not unblock after cancellation")
	}
}

func newHTTPTestManager(t *testing.T) *session.Manager {
	t.Helper()

	_, source, _, ok := runtime.Caller(0)

	if !ok {
		t.Fatal("runtime.Caller failed")
	}

	packageDir := filepath.Dir(source)
	script, err := os.ReadFile(filepath.Join(packageDir, "../session/testdata/fake-iperf3.sh"))
	if err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(t.TempDir(), "fake-iperf3")

	if err := os.WriteFile(binary, script, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("IPERF3_PATH", binary)
	t.Setenv("IPERF_FIXTURE_DIR", filepath.Clean(filepath.Join(packageDir, "../iperf/testdata")))
	t.Setenv("IPERF_BUSY_PORT", "")
	t.Setenv("IPERF_BUSY_ALL", "0")
	t.Setenv("IPERF_SLEEP_FIRST", "1")
	t.Setenv("IPERF_CALLS_FILE", filepath.Join(t.TempDir(), "calls.txt"))
	t.Setenv("IPERF_PID_FILE", "")
	t.Setenv("MNDW_BACKEND_SOCKET", filepath.Join(t.TempDir(), "backend.sock"))

	return session.NewManager()
}

func listenForProbe(t *testing.T) (net.Listener, string, int) {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}

			_ = connection.Close()
		}
	}()

	address := listener.Addr().(*net.TCPAddr)

	return listener, "127.0.0.1", address.Port
}

func dialTestSocket(t *testing.T, baseURL string) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

	defer cancel()

	url := "ws" + strings.TrimPrefix(baseURL, "http") + "/test"
	connection, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}

	return connection
}

func dialUnixTestSocket(t *testing.T, socketPath string) *websocket.Conn {
	t.Helper()

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

	defer cancel()

	connection, _, err := websocket.Dial(ctx, "ws://localhost/test", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}

	return connection
}

func waitForUnixSocket(t *testing.T, socketPath string) {
	t.Helper()

	ticker := time.NewTicker(5 * time.Millisecond)

	defer ticker.Stop()

	timeout := time.NewTimer(2 * time.Second)

	defer timeout.Stop()

	for {
		if _, err := os.Stat(socketPath); err == nil {
			return
		}

		select {
		case <-ticker.C:
		case <-timeout.C:
			t.Fatal("backend Unix socket did not appear")
		}
	}
}

func writeMessage(t *testing.T, connection *websocket.Conn, value any) {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

	defer cancel()

	if err := connection.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func readMessage(t *testing.T, connection *websocket.Conn) map[string]any {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

	defer cancel()

	_, data, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}

	var message map[string]any

	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatal(err)
	}

	return message
}

func waitForSocketType(t *testing.T, connection *websocket.Conn, messageType string) map[string]any {
	t.Helper()

	for {
		message := readMessage(t, connection)

		if message["type"] == messageType {
			return message
		}
	}
}
