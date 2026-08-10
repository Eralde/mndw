package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewNoCORSResponseWriterRemovesCORSHeaders(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := NewNoCORSResponseWriter(recorder)
	writer.Header().Set("Access-Control-Allow-Origin", "*")
	writer.Header().Set("X-Allowed", "yes")
	writer.WriteHeader(http.StatusOK)

	if recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS header survived response boundary")
	}
	if recorder.Header().Get("X-Allowed") != "yes" {
		t.Fatal("safe response header was removed")
	}
}
