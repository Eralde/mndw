package httpx

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBodyIntakeClearsDeadlineBeforeHandlerForKnownAndChunkedBodies(t *testing.T) {
	const timeout = 100 * time.Millisecond

	for _, test := range []struct {
		name    string
		request string
	}{
		{name: "known length", request: "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\ndata"},
		{name: "chunked", request: "POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ndata\r\n0\r\n\r\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			intake := NewBodyIntake(1)
			handler := intake.Middleware(func(*http.Request) BodyLimit {
				return BodyLimit{MaxBytes: 16, Timeout: timeout, TooLargeCode: CodeBodyTooLarge}
			}, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/second" {
					writer.WriteHeader(http.StatusNoContent)

					return
				}

				body, err := io.ReadAll(request.Body)
				if err != nil || string(body) != "data" {
					t.Errorf("handler body = %q, %v; want data", body, err)

					return
				}

				timer := time.NewTimer(350 * time.Millisecond)

				defer timer.Stop()

				<-timer.C

				if err := request.Context().Err(); err != nil {
					t.Errorf("request context canceled after intake: %v", err)
				}

				writer.WriteHeader(http.StatusNoContent)
			}))
			server := httptest.NewServer(ArmBodyDeadline(handler, timeout))

			t.Cleanup(server.Close)

			connection, reader := openBodyIntakeConnection(t, server)

			writeBodyIntakeRequest(t, connection, test.request)

			first := readBodyIntakeResponse(t, reader, http.MethodPost)
			_ = first.Body.Close()

			if first.StatusCode != http.StatusNoContent || first.Close {
				t.Fatalf("first response = %d close=%v; want 204 keep-alive", first.StatusCode, first.Close)
			}

			writeBodyIntakeRequest(t, connection, "GET /second HTTP/1.1\r\nHost: localhost\r\n\r\n")

			second := readBodyIntakeResponse(t, reader, http.MethodGet)
			_ = second.Body.Close()

			if second.StatusCode != http.StatusNoContent || second.Close {
				t.Fatalf("second response = %d close=%v; want 204 keep-alive", second.StatusCode, second.Close)
			}

			_ = connection.Close()
		})
	}
}

func TestBodyIntakeTimesOutSlowBodyAndClosesConnection(t *testing.T) {
	const timeout = 100 * time.Millisecond
	intake := NewBodyIntake(1)
	handler := intake.Middleware(func(*http.Request) BodyLimit {
		return BodyLimit{MaxBytes: 16, Timeout: timeout, TooLargeCode: CodeBodyTooLarge}
	}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("handler ran before body intake finished")
	}))
	server := httptest.NewServer(ArmBodyDeadline(handler, timeout))

	t.Cleanup(server.Close)

	connection, reader := openBodyIntakeConnection(t, server)

	writeBodyIntakeRequest(t, connection, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nx")

	response := readBodyIntakeResponse(t, reader, http.MethodPost)
	status, code := decodeBodyIntakeError(t, response)
	_ = response.Body.Close()

	if status != http.StatusRequestTimeout || code != CodeRequestTimeout || !response.Close {
		t.Fatalf("response = %d %q close=%v; want 408 %q and closed connection", status, code, response.Close, CodeRequestTimeout)
	}

	assertBodyIntakeConnectionClosed(t, connection, reader)
	closeBodyIntakeServerWithin(t, server)
}

func TestBodyIntakeRejectsOversizedKnownAndChunkedBodies(t *testing.T) {
	intake := NewBodyIntake(1)
	knownBody := &countingBody{Reader: strings.NewReader("too large")}
	known := httptest.NewRequest(http.MethodPost, "/", nil)
	known.Body = knownBody
	known.ContentLength = 9
	knownRecorder := httptest.NewRecorder()

	if apiErr := intake.Read(knownRecorder, known, BodyLimit{MaxBytes: 4, Timeout: time.Second, TooLargeCode: "CUSTOM_LARGE"}); apiErr == nil {
		t.Fatal("known oversized request unexpectedly succeeded")
	} else if apiErr.Status != http.StatusRequestEntityTooLarge || apiErr.Code != "CUSTOM_LARGE" {
		t.Fatalf("known oversized error = %d %q", apiErr.Status, apiErr.Code)
	}

	if knownBody.reads != 0 {
		t.Fatalf("known oversized body reads = %d, want 0", knownBody.reads)
	}

	if got := knownRecorder.Header().Get("Connection"); got != "close" {
		t.Fatalf("known oversized Connection = %q, want close", got)
	}

	chunked := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("too large"))
	chunked.ContentLength = -1
	chunkedRecorder := httptest.NewRecorder()
	apiErr := intake.Read(chunkedRecorder, chunked, BodyLimit{MaxBytes: 4, Timeout: time.Second, TooLargeCode: CodeBodyTooLarge})

	if apiErr == nil || apiErr.Status != http.StatusRequestEntityTooLarge || apiErr.Code != CodeBodyTooLarge {
		t.Fatalf("chunked oversized error = %#v, want 413 BODY_TOO_LARGE", apiErr)
	}
}

func TestBodyIntakeBoundsConcurrentReadsAndSkipsBodylessRequests(t *testing.T) {
	intake := NewBodyIntake(1)
	blocking := &blockingBody{started: make(chan struct{}), release: make(chan struct{})}
	first := httptest.NewRequest(http.MethodPost, "/", nil)
	first.Body = blocking
	first.ContentLength = -1
	firstResult := make(chan *APIError, 1)

	go func() {
		firstResult <- intake.Read(httptest.NewRecorder(), first, BodyLimit{MaxBytes: 16, Timeout: time.Second, TooLargeCode: CodeBodyTooLarge})
	}()

	select {
	case <-blocking.started:
	case <-time.After(time.Second):
		t.Fatal("first body was not read")
	}

	busyRecorder := httptest.NewRecorder()
	second := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("body"))
	busy := intake.Read(busyRecorder, second, BodyLimit{MaxBytes: 16, Timeout: time.Second, TooLargeCode: CodeBodyTooLarge})

	if busy == nil || busy.Status != http.StatusServiceUnavailable || busy.Code != CodeServerBusy {
		t.Fatalf("busy error = %#v, want 503 SERVER_BUSY", busy)
	}

	if got := busyRecorder.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}

	bodyless := httptest.NewRequest(http.MethodPost, "/", nil)

	if apiErr := intake.Read(httptest.NewRecorder(), bodyless, BodyLimit{MaxBytes: 16, Timeout: time.Second, TooLargeCode: CodeBodyTooLarge}); apiErr != nil {
		t.Fatalf("bodyless intake error = %v", apiErr)
	}

	close(blocking.release)

	select {
	case apiErr := <-firstResult:
		if apiErr != nil {
			t.Fatalf("first intake error = %v", apiErr)
		}
	case <-time.After(time.Second):
		t.Fatal("first intake did not release its slot")
	}
}

func TestArmBodyDeadlineBoundsRejectedUnreadBody(t *testing.T) {
	const timeout = 100 * time.Millisecond
	server := httptest.NewServer(ArmBodyDeadline(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	}), timeout))

	t.Cleanup(server.Close)

	connection, reader := openBodyIntakeConnection(t, server)

	writeBodyIntakeRequest(t, connection, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx")

	response := readBodyIntakeResponse(t, reader, http.MethodPost)
	_ = response.Body.Close()

	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}

	assertBodyIntakeConnectionClosed(t, connection, reader)

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
}

func TestArmBodyDeadlineSkipsBodylessRequests(t *testing.T) {
	const timeout = 20 * time.Millisecond

	writer := &readDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	var handled bool
	handler := ArmBodyDeadline(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { handled = true }), timeout)

	handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))

	if !handled {
		t.Fatal("handler was not called")
	}

	if len(writer.deadlines) != 0 {
		t.Fatalf("SetReadDeadline called %d times, want none", len(writer.deadlines))
	}
}

func openBodyIntakeConnection(t *testing.T, server *httptest.Server) (net.Conn, *bufio.Reader) {
	t.Helper()

	connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = connection.Close() })

	return connection, bufio.NewReader(connection)
}

func writeBodyIntakeRequest(t *testing.T, connection net.Conn, request string) {
	t.Helper()

	if _, err := fmt.Fprint(connection, request); err != nil {
		t.Fatal(err)
	}
}

func readBodyIntakeResponse(t *testing.T, reader *bufio.Reader, method string) *http.Response {
	t.Helper()

	response, err := http.ReadResponse(reader, &http.Request{Method: method})
	if err != nil {
		t.Fatal(err)
	}

	return response
}

func assertBodyIntakeConnectionClosed(t *testing.T, connection net.Conn, reader *bufio.Reader) {
	t.Helper()

	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}

	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("connection remained open")
	} else {
		var networkErr net.Error

		if errors.As(err, &networkErr) && networkErr.Timeout() {
			t.Fatalf("connection remained open until read timeout: %v", err)
		}
	}
}

func closeBodyIntakeServerWithin(t *testing.T, server *httptest.Server) {
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

type countingBody struct {
	io.Reader
	reads int
}

func (body *countingBody) Read(data []byte) (int, error) {
	body.reads++

	return body.Reader.Read(data)
}

func (*countingBody) Close() error { return nil }

type blockingBody struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (body *blockingBody) Read([]byte) (int, error) {
	body.once.Do(func() { close(body.started) })
	<-body.release

	return 0, io.EOF
}

func (*blockingBody) Close() error { return nil }

type readDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (writer *readDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	writer.deadlines = append(writer.deadlines, deadline)

	return nil
}

func decodeBodyIntakeError(t *testing.T, response *http.Response) (int, string) {
	t.Helper()

	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}

	return response.StatusCode, envelope.Error.Code
}
