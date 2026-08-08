package backend

import (
	"net/http"
	"testing"
)

func TestParseCGIResponseAppliesSafeDefaults(t *testing.T) {
	parsed, err := ParseCGIResponse([]byte("Status: 202 Accepted\nContent-Type: text/plain\nX-Test: ok\n\nhello"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Status != http.StatusAccepted || string(parsed.Body) != "hello" {
		t.Fatalf("parsed = %#v", parsed)
	}
	if parsed.Headers.Get("Content-Type") != "text/plain" || parsed.Headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers = %#v", parsed.Headers)
	}
}

func TestParseCGIResponseStripsForbiddenHeaders(t *testing.T) {
	parsed, err := ParseCGIResponse([]byte("Set-Cookie: secret\nConnection: close\nAccess-Control-Allow-Origin: *\nX-Good: yes\n\nbody"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Headers.Get("Set-Cookie") != "" || parsed.Headers.Get("Connection") != "" || parsed.Headers.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("forbidden headers survived: %#v", parsed.Headers)
	}
	if parsed.Headers.Get("X-Good") != "yes" {
		t.Fatalf("safe header missing: %#v", parsed.Headers)
	}
}

func TestParseCGIResponseRejectsMalformedAndOversizeOutput(t *testing.T) {
	if _, err := ParseCGIResponse([]byte("Bad Header\n\nbody"), 1024); err == nil {
		t.Fatal("malformed header accepted")
	}
	if _, err := ParseCGIResponse([]byte("123456"), 4); err == nil {
		t.Fatal("oversize output accepted")
	}
}
