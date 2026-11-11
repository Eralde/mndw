package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"terminal-page/internal/ttyd"
)

const ttydReadyTimeout = 5 * time.Second
const ttydReadyInterval = 25 * time.Millisecond

// terminal-entware is the console-specific websocket route. The host forwards
// it as X-Mndw-Route-Id; the plain terminal route stays on ndmc for backward
// compatibility. A direct console=<name> query is also accepted.
const entwareTerminalRoute = "terminal-entware"

type Server struct {
	getenv  func(string) string
	socket  string
	manager *ttyd.Manager
	mu      sync.Mutex
}

func New(getenv func(string) string) (*Server, error) {
	if getenv == nil {
		getenv = os.Getenv
	}

	socket := getenv("MNDW_BACKEND_SOCKET")

	if socket == "" {
		return nil, fmt.Errorf("MNDW_BACKEND_SOCKET is required")
	}

	return &Server{getenv: getenv, socket: socket, manager: ttyd.NewManager(getenv)}, nil
}

func (server *Server) Run(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(server.socket), 0o700); err != nil {
		return err
	}

	_ = os.Remove(server.socket)
	listener, err := net.Listen("unix", server.socket)
	if err != nil {
		return err
	}

	defer func() { _ = listener.Close(); _ = os.Remove(server.socket) }()

	_ = os.Chmod(server.socket, 0o600)

	web := &http.Server{Handler: server.handler(), ReadHeaderTimeout: 5 * time.Second}

	go func() {
		<-ctx.Done()

		_ = server.manager.Shutdown(context.Background())
		_ = web.Shutdown(context.Background())
	}()

	err = web.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}

	return err
}

// handler is the backend route table. It is separate from Run so tests can
// exercise the real mux, including the console-specific websocket paths the
// daemon gateway dials.
func (server *Server) handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", server.ready)
	mux.HandleFunc("POST /spawn", server.spawn)
	mux.HandleFunc("POST /kill", server.kill)
	mux.HandleFunc("GET /terminal", server.terminal)
	mux.HandleFunc("GET /terminal-entware", server.terminal)

	return mux
}

func (server *Server) ready(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"pluginId": server.getenv("MNDW_PLUGIN_ID"), "protocolVersion": 1})
}

func (server *Server) spawn(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 32<<10)
	var input struct {
		Console string `json:"console"`
	}

	if err := json.NewDecoder(request.Body).Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid console request"})

		return
	}

	console, ok := ttyd.ParseConsole(input.Console)
	if !ok {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid console request"})

		return
	}

	if err := server.manager.Start(request.Context(), console); err != nil {
		fmt.Fprintf(os.Stderr, "[terminal-page] failed to start ttyd: %v\n", err)

		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
			writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_NOT_INSTALLED", "message": "ttyd is not installed"})

			return
		}

		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_START_FAILED", "message": "failed to start terminal"})

		return
	}

	readyContext, cancel := context.WithTimeout(request.Context(), ttydReadyTimeout)
	err := waitForTCP(readyContext, server.manager.Port(console))

	cancel()

	if err != nil {
		server.manager.StopIfIdle(console)

		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_UNAVAILABLE", "message": "terminal did not start listening"})

		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "console": string(console)})
}

// kill is a compatibility endpoint. It only stops a console that currently
// has no proxied client connection; closing a websocket is the real release,
// and an active session is never torn down by another tab. A body-less request
// is a pure no-op (legacy callers still receive success).
func (server *Server) kill(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 32<<10)
	var input struct {
		Console string `json:"console"`
	}

	if err := json.NewDecoder(request.Body).Decode(&input); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid console request"})

		return
	}

	if input.Console != "" {
		console, ok := ttyd.ParseConsole(input.Console)
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid console request"})

			return
		}

		server.manager.StopIfIdle(console)
	}

	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) terminal(writer http.ResponseWriter, request *http.Request) {
	console, ok := consoleForRequest(request)
	if !ok {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid console request"})

		return
	}

	upstream, _, err := websocket.Dial(request.Context(), ttydWebSocketURL(server.manager.Port(console)), ttydDialOptions())
	if err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_UNAVAILABLE", "message": "terminal is not running"})

		return
	}

	if !server.manager.Acquire(console) {
		upstream.CloseNow()

		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_UNAVAILABLE", "message": "terminal is not running"})

		return
	}

	defer server.manager.Release(console)
	defer upstream.CloseNow()

	client, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"tty"}})
	if err != nil {
		return
	}

	defer client.CloseNow()

	client.SetReadLimit(32 << 20)
	upstream.SetReadLimit(32 << 20)
	proxy(request.Context(), client, upstream)
}

func consoleForRequest(request *http.Request) (ttyd.Console, bool) {
	if request.URL.Path == "/terminal-entware" {
		return ttyd.ConsoleEntware, true
	}

	raw := request.URL.Query().Get("console")

	if raw == "" && request.Header.Get("X-Mndw-Route-Id") == entwareTerminalRoute {
		raw = string(ttyd.ConsoleEntware)
	}

	return ttyd.ParseConsole(raw)
}

func ttydDialOptions() *websocket.DialOptions {
	return &websocket.DialOptions{Subprotocols: []string{"tty"}}
}

func ttydWebSocketURL(address string) string {
	return "ws://" + address + "/"
}

func waitForTCP(ctx context.Context, address string) error {
	dialer := &net.Dialer{}

	return waitForTCPWithDial(ctx, address, func(dialContext context.Context, dialAddress string) (net.Conn, error) {
		return dialer.DialContext(dialContext, "tcp", dialAddress)
	})
}

func waitForTCPWithDial(
	ctx context.Context,
	address string,
	dial func(context.Context, string) (net.Conn, error),
) error {
	var lastErr error

	for {
		connection, err := dial(ctx, address)
		if err == nil {
			_ = connection.Close()

			return nil
		}

		lastErr = err

		timer := time.NewTimer(ttydReadyInterval)

		select {
		case <-ctx.Done():
			if lastErr != nil {
				return lastErr
			}

			return ctx.Err()
		case <-timer.C:
		}
	}
}

func proxy(ctx context.Context, client, upstream *websocket.Conn) {
	ctx, cancel := context.WithCancel(ctx)

	defer cancel()

	done := make(chan struct{}, 2)
	copyMessages := func(source, destination *websocket.Conn) {
		defer func() { done <- struct{}{} }()

		for {
			typ, message, err := source.Read(ctx)
			if err != nil {
				return
			}

			if err := destination.Write(ctx, typ, message); err != nil {
				return
			}
		}
	}

	go copyMessages(client, upstream)

	go copyMessages(upstream, client)

	<-done
	cancel()

	_ = client.Close(websocket.StatusNormalClosure, "terminal closed")
	_ = upstream.Close(websocket.StatusNormalClosure, "terminal closed")
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)

	_ = json.NewEncoder(writer).Encode(value)
}
