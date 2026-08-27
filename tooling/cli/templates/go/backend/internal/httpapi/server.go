package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

const (
	readHeaderTimeout = 5 * time.Second
	shutdownTimeout   = 500 * time.Millisecond
)

type readyResponse struct {
	PluginID        string `json:"pluginId"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type helloResponse struct {
	Message string `json:"message"`
	Plugin  string `json:"plugin"`
}

// Run serves the plugin backend on the daemon-injected Unix socket until ctx is
// cancelled. It never unlinks the socket: the daemon provides a clean path and
// owns runtime-directory cleanup.
func Run(ctx context.Context) error {
	socketPath := os.Getenv("MNDW_BACKEND_SOCKET")
	pluginID := os.Getenv("MNDW_PLUGIN_ID")
	protocol, _ := strconv.Atoi(os.Getenv("MNDW_BACKEND_PROTOCOL"))

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, readyResponse{PluginID: pluginID, ProtocolVersion: protocol})
	})
	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, helloResponse{Message: helloMessage(time.Now()), Plugin: pluginID})
	})

	server := &http.Server{Handler: mux, ReadHeaderTimeout: readHeaderTimeout}
	serveErr := make(chan error, 1)

	go func() { serveErr <- server.Serve(listener) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)

		defer cancel()

		_ = server.Shutdown(shutdownCtx)

		if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}

		return nil
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}

		return err
	}
}

func helloMessage(now time.Time) string {
	return "hello + " + now.UTC().Format(time.RFC3339Nano)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	_ = json.NewEncoder(w).Encode(value)
}
