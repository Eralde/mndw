package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"terminal-page/internal/ttyd"
)

const ttydPort = "127.0.0.1:7681"
const ttydReadyTimeout = 5 * time.Second
const ttydReadyInterval = 25 * time.Millisecond

type Server struct {
	getenv  func(string) string
	socket  string
	process *ttyd.Process
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

	return &Server{getenv: getenv, socket: socket, process: ttyd.New(getenv)}, nil
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
	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", server.ready)
	mux.HandleFunc("POST /spawn", server.spawn)
	mux.HandleFunc("POST /kill", server.kill)
	mux.HandleFunc("GET /terminal", server.terminal)

	web := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		<-ctx.Done()

		_ = server.process.Stop(context.Background())
		_ = web.Shutdown(context.Background())
	}()

	err = web.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}

	return err
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

	console := input.Console

	if console != "entware" {
		console = "router"
	}

	if err := server.process.Start(request.Context(), console); err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_START_FAILED", "message": "failed to start terminal"})

		return
	}

	readyContext, cancel := context.WithTimeout(request.Context(), ttydReadyTimeout)
	err := waitForTCP(readyContext, ttydPort)

	cancel()

	if err != nil {
		_ = server.process.Stop(context.Background())

		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_UNAVAILABLE", "message": "terminal did not start listening"})

		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "console": console})
}

func (server *Server) kill(writer http.ResponseWriter, request *http.Request) {
	if err := server.process.Stop(request.Context()); err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_STOP_FAILED", "message": "failed to stop terminal"})

		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (server *Server) terminal(writer http.ResponseWriter, request *http.Request) {
	upstream, _, err := websocket.Dial(request.Context(), ttydWebSocketURL(), ttydDialOptions())
	if err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"error": "TTYD_UNAVAILABLE", "message": "terminal is not running"})

		return
	}

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

func ttydDialOptions() *websocket.DialOptions {
	return &websocket.DialOptions{Subprotocols: []string{"tty"}}
}

func ttydWebSocketURL() string {
	return "ws://" + ttydPort + "/"
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
