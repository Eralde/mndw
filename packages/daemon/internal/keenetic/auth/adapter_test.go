package auth

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

type scriptedTransport struct {
	responses []Response
	requests  []scriptedRequest
}

type scriptedRequest struct {
	Method string
	Path   string
	Body   []byte
}

func (s *scriptedTransport) Do(_ context.Context, _ Target, _ http.CookieJar, method, path string, body []byte) (Response, error) {
	s.requests = append(s.requests, scriptedRequest{Method: method, Path: path, Body: append([]byte(nil), body...)})
	response := s.responses[0]
	s.responses = s.responses[1:]
	return response, nil
}

func TestAuthenticateLegacyChallenge(t *testing.T) {
	const (
		username  = "admin"
		password  = "secret"
		challenge = "challenge"
		realm     = "router"
	)
	inner := md5.Sum([]byte(username + ":" + realm + ":" + password))
	innerHex := hex.EncodeToString(inner[:])
	proofDigest := sha256.Sum256([]byte(challenge + innerHex))
	transport := &scriptedTransport{responses: []Response{
		{Status: http.StatusUnauthorized, Header: http.Header{
			"WWW-Authenticate": []string{legacySchema},
			"X-NDM-Challenge":  []string{challenge},
			"X-NDM-Realm":      []string{realm},
		}},
		{Status: http.StatusOK},
		{Status: http.StatusOK},
	}}

	result, err := New(Options{Transport: transport}).Authenticate(context.Background(), Target{BaseURL: "http://router"}, Credentials{Username: username, Password: password}, nil)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if result.Generation != legacySchema {
		t.Fatalf("generation = %q, want %q", result.Generation, legacySchema)
	}
	var request map[string]string
	if err := json.Unmarshal(transport.requests[1].Body, &request); err != nil {
		t.Fatal(err)
	}
	want := hex.EncodeToString(proofDigest[:])
	if request["password"] != want {
		t.Fatalf("legacy proof = %q, want %q", request["password"], want)
	}
}

func TestAuthenticateScramChallenge(t *testing.T) {
	const (
		username = "admin"
		password = "secret"
		salt     = "0123456789abcdef"
	)
	transport := &scriptedTransport{}
	transport.responses = []Response{
		{Status: http.StatusUnauthorized, Header: http.Header{
			"WWW-Authenticate": []string{`x-ndw4-interactive endpoint="/auth"`},
		}},
	}

	adapter := New(Options{Transport: transport, Random: func(buffer []byte) error {
		for index := range buffer {
			buffer[index] = byte(index)
		}
		return nil
	}})

	// The fake's first phase is finalized lazily by a wrapper that can inspect the
	// nonce before returning it.
	transport.responses = nil
	transport.responses = append(transport.responses, Response{Status: http.StatusUnauthorized, Header: http.Header{
		"WWW-Authenticate": []string{`x-ndw4-interactive endpoint="/auth"`},
	}})
	transport.responses = append(transport.responses, Response{Status: http.StatusUnauthorized, Header: http.Header{ndw4ReplyHeader: []string{encodeReply(map[string]any{
		"salt":    base64.StdEncoding.EncodeToString([]byte(salt)),
		"nonce":   base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) + "server",
		"iter":    1,
		"memcost": 8,
	})}}})
	transport.responses = append(transport.responses, Response{Status: http.StatusUnauthorized, Header: http.Header{ndw4ReplyHeader: []string{encodeReply(map[string]any{
		"signature": base64.StdEncoding.EncodeToString(make([]byte, 64)),
	})}}})
	transport.responses = append(transport.responses, Response{Status: http.StatusOK}, Response{Status: http.StatusOK})

	// This transcript intentionally reaches server-signature verification. The
	// zero signature is rejected, proving the mutual-authentication guard runs.
	_, err := adapter.Authenticate(context.Background(), Target{BaseURL: "http://router"}, Credentials{Username: username, Password: password}, nil)
	if err == nil {
		t.Fatal("Authenticate() error = nil, want signature rejection")
	}
	var authErr *AuthError
	if !asAuthError(err, &authErr) || authErr.Kind != ErrorRejected {
		if authErr != nil {
			t.Fatalf("error = %v (%v), want rejected AuthError", err, authErr.Err)
		}
		t.Fatalf("error = %v, want rejected AuthError", err)
	}
	if len(transport.requests) < 3 || !strings.Contains(string(transport.requests[2].Body), `"proof"`) {
		t.Fatalf("phase two proof request missing: %+v", transport.requests)
	}
}

func encodeReply(value any) string {
	data, _ := json.Marshal(value)
	return base64.StdEncoding.EncodeToString(data)
}

func asAuthError(err error, destination **AuthError) bool {
	value, ok := err.(*AuthError)
	if ok {
		*destination = value
	}
	return ok
}

func TestScramKeyDerivationUsesArgon2idAndSha3(t *testing.T) {
	salted := argon2.IDKey([]byte("secret"), []byte("0123456789abcdef"), 1, 8, 1, 64)
	if len(salted) != 64 {
		t.Fatalf("salted password length = %d, want 64", len(salted))
	}
	if len(hmacSHA3(salted, []byte(ndw4ClientKey))) != 64 {
		t.Fatal("client key has unexpected length")
	}
}

func TestScramRejectsCostAboveConfiguredCeiling(t *testing.T) {
	transport := &scriptedTransport{responses: []Response{
		{Status: http.StatusUnauthorized, Header: http.Header{
			"WWW-Authenticate": []string{`x-ndw4-interactive endpoint="/auth"`},
		}},
		{Status: http.StatusUnauthorized, Header: http.Header{ndw4ReplyHeader: []string{encodeReply(map[string]any{
			"salt":    base64.StdEncoding.EncodeToString([]byte("0123456789abcdef")),
			"nonce":   base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) + "server",
			"iter":    65,
			"memcost": 8,
		})}}},
	}}
	adapter := New(Options{Transport: transport, Argon2Iter: 64, Argon2Memory: 32768, Random: func(buffer []byte) error {
		for index := range buffer {
			buffer[index] = byte(index)
		}
		return nil
	}})
	_, err := adapter.Authenticate(context.Background(), Target{BaseURL: "http://router"}, Credentials{Username: "admin", Password: "secret"}, nil)
	var authErr *AuthError
	if !asAuthError(err, &authErr) || authErr.Kind != ErrorUnsupported {
		t.Fatalf("error = %v, want unsupported auth error", err)
	}
}
