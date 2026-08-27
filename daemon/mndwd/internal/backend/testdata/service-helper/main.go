package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	socketPath := os.Getenv("MNDW_BACKEND_SOCKET")
	pluginID := os.Getenv("MNDW_PLUGIN_ID")
	protocol, _ := strconv.Atoi(os.Getenv("MNDW_BACKEND_PROTOCOL"))
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		panic(err)
	}
	defer listener.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /_mndw/ready", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"pluginId": pluginID, "protocolVersion": protocol})
	})
	mux.HandleFunc("GET /_mndw/diagnostics", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"status": "ready", "token": "SERVICE_SECRET", "nested": map[string]any{"authorization": "AUTH_SECRET"}})
	})
	mux.HandleFunc("GET /status", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"pluginId": pluginID, "protocolVersion": protocol})
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()

	child := exec.Command("sleep", "60")
	if err := child.Start(); err != nil {
		panic(fmt.Sprintf("start descendant: %v", err))
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
	signal.Stop(signals)
	shutdownContext, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	_ = server.Shutdown(shutdownContext)
	cancel()
	_ = child.Process.Signal(syscall.SIGTERM)
	_, _ = child.Process.Wait()
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
