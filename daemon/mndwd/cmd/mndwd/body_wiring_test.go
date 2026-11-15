package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"mndwd/internal/deviceproxy"
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

func TestDeviceProxyForwardsBufferedBodyWithContentLength(t *testing.T) {
	wantBody := "login\x00payload"

	type upstreamRequest struct {
		body             string
		contentLength    int64
		transferEncoding []string
		transferHeader   string
	}

	upstreamRequests := make(chan upstreamRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read upstream body: %v", err)
		}

		upstreamRequests <- upstreamRequest{
			body:             string(body),
			contentLength:    request.ContentLength,
			transferEncoding: append([]string(nil), request.TransferEncoding...),
			transferHeader:   request.Header.Get("Transfer-Encoding"),
		}
	}))

	t.Cleanup(upstream.Close)

	proxy, err := deviceproxy.New(upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()

	registerDeviceProxyRoutes(mux, proxy, httpx.NewBodyIntake(1), httpx.JSONBodyTimeout)

	frontDoor := httptest.NewServer(mux)

	t.Cleanup(frontDoor.Close)

	connection, err := net.Dial("tcp", strings.TrimPrefix(frontDoor.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = connection.Close() })

	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}

	if _, err := fmt.Fprintf(connection, "POST /rci/status HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n%x\r\n%s\r\n0\r\n\r\n", len(wantBody), wantBody); err != nil {
		t.Fatal(err)
	}

	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}

	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	var got upstreamRequest

	select {
	case got = <-upstreamRequests:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream did not receive request")
	}

	if got.body != wantBody {
		t.Fatalf("upstream body = %q, want %q", got.body, wantBody)
	}

	if got.contentLength != int64(len(wantBody)) {
		t.Fatalf("upstream Content-Length = %d, want %d", got.contentLength, len(wantBody))
	}

	if len(got.transferEncoding) != 0 || got.transferHeader != "" {
		t.Fatalf("upstream Transfer-Encoding = %v, header = %q; want no transfer encoding", got.transferEncoding, got.transferHeader)
	}
}

func TestDeviceProxyRejectsOversizedBodiesByPrefix(t *testing.T) {
	var upstreamCalled atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		upstreamCalled.Store(true)
	}))

	t.Cleanup(upstream.Close)

	proxy, err := deviceproxy.New(upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		path     string
		maxBytes int
	}{
		{path: "/auth", maxBytes: 16 << 10},
		{path: "/rci/status", maxBytes: 1 << 20},
		{path: "/ci/firmware.bin", maxBytes: 16 << 10},
	} {
		t.Run(test.path, func(t *testing.T) {
			mux := http.NewServeMux()

			registerDeviceProxyRoutes(mux, proxy, httpx.NewBodyIntake(1), httpx.JSONBodyTimeout)

			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(strings.Repeat("x", test.maxBytes+1)))
			response := httptest.NewRecorder()

			mux.ServeHTTP(response, request)

			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}

			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode error response: %v", err)
			}

			if response.Code != http.StatusRequestEntityTooLarge || envelope.Error.Code != httpx.CodeBodyTooLarge {
				t.Fatalf("response = %d %q, want 413 %q", response.Code, envelope.Error.Code, httpx.CodeBodyTooLarge)
			}

			if upstreamCalled.Load() {
				t.Fatal("oversized request reached upstream")
			}
		})
	}
}

func TestDeviceProxyTimesOutSlowBodyAndClosesConnection(t *testing.T) {
	const timeout = 100 * time.Millisecond
	var upstreamCalled atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		upstreamCalled.Store(true)
	}))

	t.Cleanup(upstream.Close)

	proxy, err := deviceproxy.New(upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()

	proxyIntake := httpx.NewBodyIntake(1)

	registerDeviceProxyRoutes(mux, proxy, proxyIntake, timeout)

	server := httptest.NewServer(httpx.ArmBodyDeadline(frontend.TraversalGuard(mux), httpx.JSONBodyTimeout))

	t.Cleanup(server.Close)

	connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = connection.Close() })

	if _, err := fmt.Fprint(connection, "POST /rci/status HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nx"); err != nil {
		t.Fatal(err)
	}

	if err := connection.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}

	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}

	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}

	_ = response.Body.Close()

	if response.StatusCode != http.StatusRequestTimeout || envelope.Error.Code != httpx.CodeRequestTimeout || !response.Close {
		t.Fatalf("response = %d %q close=%v; want 408 %q and closed connection", response.StatusCode, envelope.Error.Code, response.Close, httpx.CodeRequestTimeout)
	}

	if upstreamCalled.Load() {
		t.Fatal("slow request reached upstream")
	}

	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("connection remained open after request timeout")
	} else if networkErr, ok := err.(net.Error); ok && networkErr.Timeout() {
		t.Fatalf("connection remained open until read timeout: %v", err)
	}

	closeServerWithin(t, server)
}

func TestDeviceProxyIntakeHasIndependentSlots(t *testing.T) {
	mux := http.NewServeMux()
	proxyIntake := httpx.NewBodyIntake(1)

	registerDeviceProxyRoutes(mux, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), proxyIntake, time.Second)

	managementIntake := httpx.NewBodyIntake(1)
	blockedBody := &stalledProxyBody{started: make(chan struct{}), release: make(chan struct{})}
	proxyRequest := httptest.NewRequest(http.MethodPost, "/rci", nil)
	proxyRequest.Body = blockedBody
	proxyRequest.ContentLength = -1
	proxyResult := make(chan *httpx.APIError, 1)

	go func() {
		proxyResult <- proxyIntake.Read(httptest.NewRecorder(), proxyRequest, httpx.BodyLimit{MaxBytes: 16, Timeout: time.Second, TooLargeCode: httpx.CodeBodyTooLarge})
	}()

	select {
	case <-blockedBody.started:
	case <-time.After(time.Second):
		t.Fatal("proxy intake did not start reading")
	}

	managementRequest := httptest.NewRequest(http.MethodPost, "/api/mgmt", strings.NewReader("body"))

	if apiErr := managementIntake.Read(httptest.NewRecorder(), managementRequest, httpx.BodyLimit{MaxBytes: 16, Timeout: time.Second, TooLargeCode: httpx.CodeBodyTooLarge}); apiErr != nil {
		t.Fatalf("management intake was blocked by proxy intake: %v", apiErr)
	}

	close(blockedBody.release)

	select {
	case apiErr := <-proxyResult:
		if apiErr != nil {
			t.Fatalf("proxy intake error = %v", apiErr)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy intake did not finish")
	}
}

type stalledProxyBody struct {
	started chan struct{}
	release chan struct{}
}

func (body *stalledProxyBody) Read([]byte) (int, error) {
	select {
	case <-body.started:
	default:
		close(body.started)
	}

	<-body.release

	return 0, io.EOF
}

func (*stalledProxyBody) Close() error { return nil }

func closeServerWithin(t *testing.T, server *httptest.Server) {
	t.Helper()

	closed := make(chan struct{})

	go func() {
		server.Close()
		close(closed)
	}()

	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Server.Close did not return within the bound")
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
