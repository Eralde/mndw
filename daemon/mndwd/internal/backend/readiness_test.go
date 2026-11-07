package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestProbeReadinessValidatesIdentityAndProtocol(t *testing.T) {
	socket := shortUnixSocketPath(t, "ready.sock")
	listener := listenUnixForTest(t, socket)

	defer listener.Close()

	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/_mndw/ready" {
			http.NotFound(writer, request)

			return
		}

		writer.Header().Set("Content-Type", "application/json")

		_ = json.NewEncoder(writer).Encode(map[string]any{"pluginId": "demo", "protocolVersion": 1})
	})}

	go func() { _ = server.Serve(listener) }()

	defer server.Shutdown(context.Background())

	if err := ProbeReadiness(context.Background(), socket, "demo", 1, time.Second); err != nil {
		t.Fatal(err)
	}

	if err := ProbeReadiness(context.Background(), socket, "other", 1, time.Second); err == nil {
		t.Fatal("wrong plugin identity accepted")
	}
}

func TestProbeReadinessWaitsForLateSocket(t *testing.T) {
	attempts := 0
	err := retryReadiness(context.Background(), func(context.Context) (bool, error) {
		attempts++

		if attempts < 3 {
			return true, errors.New("socket is not listening yet")
		}

		return false, nil
	})
	if err != nil {
		t.Fatalf("late socket readiness failed: %v", err)
	}

	if attempts != 3 {
		t.Fatalf("readiness attempts = %d, want 3", attempts)
	}
}

func TestProbeReadinessRejectsOversizeOrMalformedResponses(t *testing.T) {
	for index, body := range []string{"not-json", fmt.Sprintf("%0200d", 1)} {
		socket := shortUnixSocketPath(t, fmt.Sprintf("ready-%d.sock", index))
		listener := listenUnixForTest(t, socket)

		server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(body))
		})}
		go func() { _ = server.Serve(listener) }()

		if err := ProbeReadiness(context.Background(), socket, "demo", 1, time.Second); err == nil {
			t.Errorf("response %d accepted", index)
		}

		_ = server.Shutdown(context.Background())
		_ = listener.Close()
	}
}
