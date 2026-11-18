package httpx

import (
	"bufio"
	"bytes"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestLogMiddlewareUsesSeverityAndOmitsQueryAndBody(t *testing.T) {
	start := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	tests := []struct {
		name     string
		status   int
		duration time.Duration
		level    string
	}{
		{name: "healthy", status: http.StatusOK, duration: time.Second, level: "DEBUG"},
		{name: "server error", status: http.StatusInternalServerError, duration: time.Second, level: "WARN"},
		{name: "slow", status: http.StatusOK, duration: 6 * time.Second, level: "WARN"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
			clockCalls := 0
			handler := logMiddleware(logger, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(test.status)
			}), func() time.Time {
				clockCalls++

				if clockCalls == 1 {
					return start
				}

				return start.Add(test.duration)
			})
			request := httptest.NewRequest(http.MethodPost, "/api/items?token=QUERY_SECRET", strings.NewReader("BODY_SECRET"))

			handler.ServeHTTP(httptest.NewRecorder(), request)

			text := output.String()

			if !strings.Contains(text, "level="+test.level) || !strings.Contains(text, "method=POST") || !strings.Contains(text, "path=/api/items") || !strings.Contains(text, "status="+strconv.Itoa(test.status)) || !strings.Contains(text, "duration="+test.duration.String()) {
				t.Fatalf("request log missing fields or severity: %s", text)
			}

			if strings.Contains(text, "QUERY_SECRET") || strings.Contains(text, "BODY_SECRET") {
				t.Fatalf("request log leaked query or body: %s", text)
			}
		})
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
