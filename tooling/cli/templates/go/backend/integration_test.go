package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"__MNDW_NAME__/internal/httpapi"
)

func TestRunServesReadinessAndHelloThenShutsDown(t *testing.T) {
	socket := testSocket(t)

	t.Setenv("MNDW_BACKEND_SOCKET", socket)
	t.Setenv("MNDW_PLUGIN_ID", "generated-go-page")
	t.Setenv("MNDW_BACKEND_PROTOCOL", "1")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)

	go func() { done <- httpapi.Run(ctx) }()

	stopped := false

	t.Cleanup(func() {
		cancel()

		if !stopped {
			waitStopped(t, done)
		}
	})

	client := unixClient(socket)
	ready := waitReady(t, client)

	if ready.PluginID != "generated-go-page" {
		t.Fatalf("readiness pluginId = %q, want generated-go-page", ready.PluginID)
	}

	if ready.ProtocolVersion != 1 {
		t.Fatalf("readiness protocolVersion = %d, want 1", ready.ProtocolVersion)
	}

	response, err := client.Get("http://unix/hello")
	if err != nil {
		t.Fatal(err)
	}

	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("/hello status = %d", response.StatusCode)
	}

	var hello struct {
		Message string `json:"message"`
	}

	if err := json.NewDecoder(response.Body).Decode(&hello); err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(hello.Message, "hello + ") {
		t.Fatalf("/hello message = %q, want hello + timestamp", hello.Message)
	}

	if _, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(hello.Message, "hello + ")); err != nil {
		t.Fatalf("/hello message timestamp is invalid: %q: %v", hello.Message, err)
	}

	cancel()
	waitStopped(t, done)

	stopped = true
}

func TestRunReflectsMalformedProtocolAsZero(t *testing.T) {
	socket := testSocket(t)

	t.Setenv("MNDW_BACKEND_SOCKET", socket)
	t.Setenv("MNDW_PLUGIN_ID", "generated-go-page")
	t.Setenv("MNDW_BACKEND_PROTOCOL", "not-a-number")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)

	go func() { done <- httpapi.Run(ctx) }()

	t.Cleanup(func() {
		cancel()
		waitStopped(t, done)
	})

	ready := waitReady(t, unixClient(socket))

	if ready.ProtocolVersion != 0 {
		t.Fatalf("malformed protocol should reflect 0, got %d", ready.ProtocolVersion)
	}
}

type readyBody struct {
	PluginID        string `json:"pluginId"`
	ProtocolVersion int    `json:"protocolVersion"`
}

func testSocket(t *testing.T) string {
	t.Helper()

	socket := filepath.Join("/tmp", fmt.Sprintf("mndw-go-backend-%d.sock", os.Getpid()))
	_ = os.Remove(socket)

	t.Cleanup(func() { _ = os.Remove(socket) })

	return socket
}

func unixClient(socket string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
}

func waitReady(t *testing.T, client *http.Client) readyBody {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)

	for time.Now().Before(deadline) {
		response, err := client.Get("http://unix/_mndw/ready")
		if err == nil {
			if response.StatusCode == http.StatusOK {
				var body readyBody
				decodeErr := json.NewDecoder(response.Body).Decode(&body)
				_ = response.Body.Close()

				if decodeErr != nil {
					t.Fatalf("decode readiness: %v", decodeErr)
				}

				return body
			}

			_ = response.Body.Close()
		}

		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("backend never became ready")

	return readyBody{}
}

func waitStopped(t *testing.T, done <-chan error) {
	t.Helper()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run goroutine did not exit within 2s of cancellation")
	}
}
