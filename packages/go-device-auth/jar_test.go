package auth

import (
	"context"
	"net/http"
	"testing"
)

// jarRecordingTransport captures the CookieJar passed to each request so a test
// can assert the legacy fallback runs on a session distinct from the failed
// x-ndw4 attempt. The copied scriptedTransport discards the jar and cannot.
type jarRecordingTransport struct {
	responses []Response
	jars      []http.CookieJar
}

func (j *jarRecordingTransport) Do(_ context.Context, _ Target, jar http.CookieJar, _, _ string, _ []byte) (Response, error) {
	j.jars = append(j.jars, jar)
	response := j.responses[0]
	j.responses = j.responses[1:]

	return response, nil
}

func TestLegacyFallbackUsesFreshCookieJar(t *testing.T) {
	transport := &jarRecordingTransport{responses: []Response{
		{Status: http.StatusUnauthorized, Header: http.Header{
			"WWW-Authenticate": []string{
				`x-ndw2-interactive realm="router"`,
				`x-ndw4-interactive endpoint="/auth"`,
			},
		}},
		{Status: http.StatusUnauthorized}, // x-ndw4 reply malformed -> triggers fallback
		{Status: http.StatusUnauthorized, Header: http.Header{
			"WWW-Authenticate": []string{"x-ndw2-interactive"},
			"X-NDM-Challenge":  []string{"challenge"},
			"X-NDM-Realm":      []string{"router"},
		}},
		{Status: http.StatusOK},
		{Status: http.StatusOK},
	}}
	adapter := New(Options{Transport: transport, Random: func(buffer []byte) error {
		for index := range buffer {
			buffer[index] = byte(index)
		}

		return nil
	}})

	result, err := adapter.Authenticate(context.Background(), Target{BaseURL: "http://router"}, Credentials{Username: "admin", Password: "secret"}, nil)
	if err != nil {
		t.Fatalf("Authenticate() error = %v, want legacy fallback success", err)
	}

	if result.Generation != legacySchema {
		t.Fatalf("generation = %q, want %q", result.Generation, legacySchema)
	}

	if len(transport.jars) != 5 {
		t.Fatalf("recorded %d jars, want 5", len(transport.jars))
	}

	// jars[0..1] are the x-ndw4 attempt; jars[2..4] are the x-ndw2 fallback.
	if transport.jars[0] == nil || transport.jars[2] == nil {
		t.Fatal("cookie jars must be non-nil")
	}

	if transport.jars[0] != transport.jars[1] {
		t.Fatal("the x-ndw4 attempt must reuse a single jar")
	}

	if transport.jars[2] != transport.jars[3] || transport.jars[3] != transport.jars[4] {
		t.Fatal("the x-ndw2 fallback must reuse a single jar")
	}

	if transport.jars[1] == transport.jars[2] {
		t.Fatal("legacy fallback must use a fresh cookie jar, not the failed x-ndw4 session")
	}
}
