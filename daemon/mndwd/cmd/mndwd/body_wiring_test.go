package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mndwd/internal/frontend"
	"mndwd/internal/httpx"
)

func TestEarlyDeviceProxyPathRejectionsCloseConnection(t *testing.T) {
	for _, test := range []struct {
		path       string
		wantStatus int
	}{
		{path: "/rci//status", wantStatus: http.StatusTemporaryRedirect},
		{path: "/rci/../x", wantStatus: http.StatusNotFound},
	} {
		t.Run(test.path, func(t *testing.T) {
			mux := http.NewServeMux()
			proxy := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("noncanonical request reached proxy")
			})

			for _, prefix := range deviceProxyPrefixes {
				mux.Handle(prefix, proxy)
				mux.Handle(prefix+"/", proxy)
			}

			handler := httpx.ArmBodyDeadline(frontend.TraversalGuard(mux), 80*time.Millisecond)
			server := httptest.NewServer(handler)

			t.Cleanup(server.Close)

			connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}

			t.Cleanup(func() { _ = connection.Close() })

			if _, err := fmt.Fprintf(connection, "POST %s HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx", test.path); err != nil {
				t.Fatal(err)
			}

			if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
				t.Fatal(err)
			}

			reader := bufio.NewReader(connection)
			response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPost})
			if err != nil {
				_ = connection.Close()

				t.Fatal(err)
			}

			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()

			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}

			if _, err := reader.ReadByte(); err == nil {
				t.Fatal("connection remained open after early rejection")
			} else if networkErr, ok := err.(net.Error); ok && networkErr.Timeout() {
				_ = connection.Close()

				t.Fatalf("connection remained open until read timeout: %v", err)
			}

			closed := make(chan struct{})

			go func() {
				server.Close()
				close(closed)
			}()

			select {
			case <-closed:
			case <-time.After(5 * time.Second):
				t.Fatal("Server.Close did not return after bounded body drain")
			}
		})
	}
}

func TestDeviceProxyClearsRootBodyDeadline(t *testing.T) {
	const timeout = 80 * time.Millisecond

	mux := http.NewServeMux()
	proxyReady := make(chan struct{})
	proxy := httpx.ClearBodyDeadline(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		close(proxyReady)

		body, err := io.ReadAll(request.Body)
		if err != nil || string(body) != "data" {
			t.Errorf("proxy body = %q, %v; want data", body, err)
		}

		writer.WriteHeader(http.StatusNoContent)
	}))

	for _, prefix := range deviceProxyPrefixes {
		mux.Handle(prefix, proxy)
		mux.Handle(prefix+"/", proxy)
	}

	server := httptest.NewServer(httpx.ArmBodyDeadline(frontend.TraversalGuard(mux), timeout))

	t.Cleanup(server.Close)

	connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = connection.Close() })

	if _, err := fmt.Fprint(connection, "POST /rci/status HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n"); err != nil {
		t.Fatal(err)
	}

	select {
	case <-proxyReady:
	case <-time.After(5 * time.Second):
		t.Fatal("proxy handler did not start reading request body")
	}

	timer := time.NewTimer(3 * timeout)

	<-timer.C

	if _, err := fmt.Fprint(connection, "data"); err != nil {
		t.Fatal(err)
	}

	if err := connection.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}

	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}

	_ = response.Body.Close()

	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusNoContent)
	}
}

func TestRejectWebSocketBodyBeforeUpgrade(t *testing.T) {
	called := false
	handler := rejectWebSocketBody(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	request := httptest.NewRequest(http.MethodGet, "/ws/events", strings.NewReader("body"))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if called {
		t.Fatal("websocket handler ran for request with a body")
	}

	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"BAD_REQUEST"`) {
		t.Fatalf("response = %d %s, want 400 BAD_REQUEST", response.Code, response.Body.String())
	}

	if response.Header().Get("Connection") != "close" {
		t.Fatalf("Connection = %q, want close", response.Header().Get("Connection"))
	}

	called = false
	response = httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ws/events", nil))

	if !called {
		t.Fatal("websocket handler was not called for bodyless request")
	}
}
