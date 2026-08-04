package minter

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"mndwd/internal/keenetic/auth"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

func TestProvisionReturnsMixedPerMemberOutcomes(t *testing.T) {
	generator := GeneratorFunc(func(_ context.Context, member enumeration.Member, _ Credentials) (model.TokenRecord, error) {
		if member.Identity == "node-2" {
			return model.TokenRecord{}, errors.New("unreachable")
		}
		return model.TokenRecord{Key: member.Identity + "-key", Token: member.Identity + "-token", Support: model.SupportSupported}, nil
	})
	members := []enumeration.Member{
		{Identity: "node-1", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:01"},
		{Identity: "node-2", IP: "192.168.1.3", MAC: "aa:bb:cc:dd:ee:02"},
	}

	outcomes := Provision(context.Background(), generator, members, Credentials{Username: "admin", Password: "password"})
	if len(outcomes) != 2 {
		t.Fatalf("outcomes = %#v", outcomes)
	}
	if outcomes[0].Record.Token != "node-1-token" || outcomes[0].Err != nil {
		t.Fatalf("success outcome = %#v", outcomes[0])
	}
	if outcomes[1].Err == nil || outcomes[1].Record.Token != "" {
		t.Fatalf("failure outcome = %#v", outcomes[1])
	}
}

type GeneratorFunc func(context.Context, enumeration.Member, Credentials) (model.TokenRecord, error)

func (f GeneratorFunc) Generate(ctx context.Context, member enumeration.Member, credentials Credentials) (model.TokenRecord, error) {
	return f(ctx, member, credentials)
}

func TestDefaultRequestBodyUsesAuthenticationProbe(t *testing.T) {
	if string(DefaultRequestBody()) != `{"probe":"authentication token generate"}` {
		t.Fatalf("request body = %s", DefaultRequestBody())
	}
	if string(DefaultTokenRequestBody()) != `{"authentication":{"token":{"generate":{"user-data":"mndw"}}}}` {
		t.Fatalf("token request body = %s", DefaultTokenRequestBody())
	}
}

func TestHTTPGeneratorUsesSecureFQDNWithoutIP(t *testing.T) {
	authenticator := &recordingAuthenticator{}
	transport := &recordingTransport{responses: []auth.Response{
		{Status: http.StatusOK, Body: []byte(`{"probe":{"found":true}}`)},
		{Status: http.StatusOK, Body: []byte(`{"authentication":{"token":{"generate":{"id":"generated-key","value":"generated-token"}}}}`)},
	}}
	generator := HTTPGenerator{Authenticator: authenticator, Transport: transport, RequestBody: DefaultRequestBody}

	record, err := generator.Generate(context.Background(), enumeration.Member{
		Identity: "node-1",
		FQDN:     "NODE-1.keenetic.io.",
	}, Credentials{Username: "admin", Password: "password"})
	if err != nil {
		t.Fatal(err)
	}
	if record.Token != "generated-token" || authenticator.target.BaseURL != "https://node-1.keenetic.io" {
		t.Fatalf("record = %#v, auth target = %#v", record, authenticator.target)
	}
	if transport.target.BaseURL != "https://node-1.keenetic.io" || transport.method != http.MethodPost || transport.path != "/rci/" {
		t.Fatalf("transport target = %#v, method = %s, path = %s", transport.target, transport.method, transport.path)
	}
	if len(transport.bodies) != 2 || string(transport.bodies[0]) != `{"probe":"authentication token generate"}` || string(transport.bodies[1]) != `{"authentication":{"token":{"generate":{"user-data":"mndw"}}}}` {
		t.Fatalf("transport bodies = %q", transport.bodies)
	}
}

func TestHTTPGeneratorRejectsUnsupportedTokenProbe(t *testing.T) {
	transport := &recordingTransport{responses: []auth.Response{{
		Status: http.StatusOK,
		Body:   []byte(`{"probe":{"found":false}}`),
	}}}
	generator := HTTPGenerator{Authenticator: &recordingAuthenticator{}, Transport: transport, RequestBody: DefaultRequestBody}

	_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, Credentials{})
	if !errors.Is(err, ErrTokenGenerationUnsupported) {
		t.Fatalf("error = %v, want unsupported probe", err)
	}
	if transport.calls != 1 {
		t.Fatalf("transport calls = %d, want probe only", transport.calls)
	}
}

func TestHTTPGeneratorDoesNotMintTokenOnHTTPFallback(t *testing.T) {
	authenticator := &recordingAuthenticator{}
	transport := &recordingTransport{}
	generator := HTTPGenerator{Authenticator: authenticator, Transport: transport, RequestBody: DefaultRequestBody}

	_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", IP: "192.168.1.8"}, Credentials{
		Username: "admin",
		Password: "password",
	})
	if !errors.Is(err, ErrPersistentTokenRequiresHTTPS) {
		t.Fatalf("error = %v, want ErrPersistentTokenRequiresHTTPS", err)
	}
	if authenticator.target.BaseURL != "http://192.168.1.8" || transport.calls != 0 {
		t.Fatalf("auth target = %#v, transport calls = %d", authenticator.target, transport.calls)
	}
}

func TestHTTPGeneratorClassifiesTokenGenerationStatuses(t *testing.T) {
	tests := []struct {
		status int
		want   error
	}{
		{status: http.StatusUnauthorized, want: ErrTokenGenerationRejected},
		{status: http.StatusForbidden, want: ErrTokenGenerationRejected},
		{status: http.StatusNotFound, want: ErrTokenGenerationUnsupported},
		{status: http.StatusMethodNotAllowed, want: ErrTokenGenerationUnsupported},
		{status: http.StatusNotImplemented, want: ErrTokenGenerationUnsupported},
		{status: http.StatusBadGateway, want: ErrTokenGenerationUnreachable},
	}
	for _, test := range tests {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			generator := HTTPGenerator{
				Authenticator: &recordingAuthenticator{},
				Transport: &recordingTransport{responses: []auth.Response{
					{Status: http.StatusOK, Body: []byte(`{"probe":{"found":true}}`)},
					{Status: test.status},
				}},
				RequestBody: DefaultRequestBody,
			}
			_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, Credentials{})
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestHTTPGeneratorPreservesTypedAuthenticationError(t *testing.T) {
	underlying := errors.New("private authentication detail")
	authError := &auth.AuthError{Kind: auth.ErrorRejected, Err: underlying}
	generator := HTTPGenerator{Authenticator: &recordingAuthenticator{err: authError}}

	_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, Credentials{})
	var recovered *auth.AuthError
	if !errors.Is(err, ErrAuthentication) || !errors.As(err, &recovered) || recovered != authError {
		t.Fatalf("error = %v, recovered = %#v", err, recovered)
	}
}

func TestHTTPGeneratorLogsSafeAuthenticationFailureDetails(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	generator := HTTPGenerator{
		Authenticator: &recordingAuthenticator{err: &auth.AuthError{Kind: auth.ErrorMalformed, Err: errors.New("scram reply missing")}},
		Logger:        logger,
	}

	_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, Credentials{})
	if err == nil {
		t.Fatal("Generate() error = nil, want authentication failure")
	}
	output := logs.String()
	if !strings.Contains(output, "extender provisioning failed") || !strings.Contains(output, "identity=node-1") || !strings.Contains(output, "phase=authentication") || !strings.Contains(output, "auth_kind=malformed") {
		t.Fatalf("logs = %q, want safe authentication details", output)
	}
	if strings.Contains(output, "scram reply missing") || strings.Contains(output, "password") || strings.Contains(output, "token") {
		t.Fatalf("logs contain protocol detail or secret: %q", output)
	}
}

func TestHTTPGeneratorPreservesAllFallbackAuthenticationErrors(t *testing.T) {
	scramError := &auth.AuthError{Kind: auth.ErrorMalformed, Err: errors.New("scram reply missing")}
	legacyError := &auth.AuthError{Kind: auth.ErrorRejected, Err: errors.New("legacy proof rejected")}
	generator := HTTPGenerator{Authenticator: &recordingAuthenticator{err: errors.Join(legacyError, scramError)}}

	_, err := generator.Generate(context.Background(), enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, Credentials{})
	if !errors.Is(err, legacyError) || !errors.Is(err, scramError) {
		t.Fatalf("error = %v, want both fallback authentication errors", err)
	}
}

func TestHTTPGeneratorClassifiesTargetAndDependencyFailures(t *testing.T) {
	tests := []struct {
		name      string
		generator HTTPGenerator
		member    enumeration.Member
		want      error
		authCalls int
	}{
		{name: "missing authenticator", generator: HTTPGenerator{}, member: enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, want: ErrGeneratorUnavailable},
		{name: "offline", generator: HTTPGenerator{Authenticator: &recordingAuthenticator{}}, member: enumeration.Member{Identity: "node-1"}, want: ErrMemberOffline},
		{name: "invalid target", generator: HTTPGenerator{Authenticator: &recordingAuthenticator{}}, member: enumeration.Member{Identity: "node-1", IP: "192.168.1.8", FQDN: "bad_name.keenetic.io"}, want: ErrTargetInvalid},
		{name: "secure dependencies", generator: HTTPGenerator{Authenticator: &recordingAuthenticator{}}, member: enumeration.Member{Identity: "node-1", FQDN: "node-1.keenetic.io"}, want: ErrGeneratorUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.generator.Generate(context.Background(), test.member, Credentials{})
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

type recordingAuthenticator struct {
	target auth.Target
	err    error
}

func (a *recordingAuthenticator) Authenticate(_ context.Context, target auth.Target, _ auth.Credentials, _ http.CookieJar) (auth.AuthResult, error) {
	a.target = target
	return auth.AuthResult{}, a.err
}

type recordingTransport struct {
	target    auth.Target
	method    string
	path      string
	body      []byte
	bodies    [][]byte
	response  auth.Response
	responses []auth.Response
	err       error
	calls     int
}

func (t *recordingTransport) Do(_ context.Context, target auth.Target, _ http.CookieJar, method, path string, body []byte) (auth.Response, error) {
	t.calls++
	t.target = target
	t.method = method
	t.path = path
	t.body = append([]byte(nil), body...)
	t.bodies = append(t.bodies, append([]byte(nil), body...))
	if len(t.responses) > 0 {
		response := t.responses[0]
		t.responses = t.responses[1:]
		return response, t.err
	}
	return t.response, t.err
}
