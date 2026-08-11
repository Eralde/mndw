package httpx

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNoCORSResponseWriterStripsHeadersCaseInsensitively(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := NewNoCORSResponseWriter(recorder)
	writer.Header()["Access-Control-Allow-Origin"] = []string{"*"}
	writer.Header()["access-control-allow-headers"] = []string{"Authorization"}
	writer.Header()["ACCESS-CONTROL-EXPOSE-HEADERS"] = []string{"X-Trace"}

	writer.Header().Set("Content-Type", "text/plain")

	if _, err := writer.Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}

	for key := range recorder.Header() {
		if strings.HasPrefix(strings.ToLower(key), "access-control-") {
			t.Fatalf("CORS header survived: %q", key)
		}
	}

	if got := recorder.Header().Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type = %q, want text/plain", got)
	}
}

func TestNoCORSResponseWriterHonorsExplicitStatus(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := NewNoCORSResponseWriter(recorder)

	writer.WriteHeader(http.StatusCreated)

	if _, err := writer.Write([]byte("created")); err != nil {
		t.Fatal(err)
	}

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusCreated)
	}
}

func TestNoCORSResponseWriterUnwrapsForResponseController(t *testing.T) {
	underlying := &hijackResponseWriter{}
	writer := NewNoCORSResponseWriter(underlying)
	connection, _, err := http.NewResponseController(writer).Hijack()
	if err != nil {
		t.Fatal(err)
	}

	if connection != underlying.connection {
		t.Fatal("ResponseController did not reach underlying hijacker")
	}

	_ = connection.Close()
}

type hijackResponseWriter struct {
	connection net.Conn
}

func (writer *hijackResponseWriter) Header() http.Header { return make(http.Header) }

func (writer *hijackResponseWriter) WriteHeader(int) {}

func (writer *hijackResponseWriter) Write(data []byte) (int, error) { return len(data), nil }

func (writer *hijackResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, peer := net.Pipe()
	_ = peer.Close()
	writer.connection = connection

	return connection, bufio.NewReadWriter(bufio.NewReader(connection), bufio.NewWriter(connection)), nil
}
