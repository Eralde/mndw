package backend

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSupervisorLiveDiagnosticsValidatesBoundedJSON(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		status      int
		body        string
		wantError   string
	}{
		{name: "valid", contentType: "application/json; charset=utf-8", status: http.StatusOK, body: `{"status":"ready"}`},
		{name: "wrong content type", contentType: "text/plain", status: http.StatusOK, body: `{}`, wantError: "content type"},
		{name: "invalid json", contentType: "application/json", status: http.StatusOK, body: `[]`, wantError: "object"},
		{name: "status", contentType: "application/json", status: http.StatusBadGateway, body: `{}`, wantError: "status"},
		{name: "oversize", contentType: "application/json", status: http.StatusOK, body: `{"data":"` + strings.Repeat("x", int(defaultLiveDiagnosticsBytes)) + `"}`, wantError: "exceeds"},
	}

	for _, test := range tests {
		test := test

		t.Run(test.name, func(t *testing.T) {
			socketPath := startDiagnosticsServer(t, func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", test.contentType)
				writer.WriteHeader(test.status)

				_, _ = writer.Write([]byte(test.body))
			})
			supervisor := supervisorForDiagnosticsSocket(socketPath)
			body, err := supervisor.LiveDiagnostics(context.Background(), "demo")

			if test.wantError == "" {
				if err != nil || string(body) != test.body {
					t.Fatalf("body=%q error=%v", body, err)
				}

				return
			}

			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(test.wantError)) {
				t.Fatalf("error=%v, want substring %q", err, test.wantError)
			}
		})
	}
}

func TestSupervisorLiveDiagnosticsHasShortTimeout(t *testing.T) {
	socketPath := startDiagnosticsServer(t, func(writer http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	})
	supervisor := supervisorForDiagnosticsSocket(socketPath)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)

	defer cancel()

	started := time.Now()
	_, err := supervisor.LiveDiagnostics(ctx, "demo")
	if err == nil {
		t.Fatal("timeout request succeeded")
	}

	if time.Since(started) > time.Second {
		t.Fatalf("timeout took too long: %s", time.Since(started))
	}
}

func supervisorForDiagnosticsSocket(socketPath string) *Supervisor {
	supervisor := NewSupervisor(SupervisorConfig{RuntimeRoot: filepath.Dir(socketPath)})
	supervisor.services["demo"] = &serviceRecord{
		paths:  RuntimePaths{BackendSocket: socketPath},
		status: RuntimeStatus{State: StateReady},
	}

	return supervisor
}

func startDiagnosticsServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()

	directory := t.TempDir()
	socketPath := filepath.Join(directory, "backend.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Skipf("sandbox disallows Unix listeners: %v", err)
	}

	server := &http.Server{Handler: handler}

	go func() { _ = server.Serve(listener) }()

	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
		_ = os.Remove(socketPath)
	})

	return socketPath
}
