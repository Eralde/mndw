// Package minter mints controller and extender RCI tokens by authenticating to
// each device via mndw's device-auth and issuing the token-request RCI calls.
package minter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"mndw.local/device-auth"
	rci "mndw.local/rci"
	"mndwd/internal/discovery"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/target"
)

var (
	ErrPersistentTokenRequiresHTTPS = errors.New("persistent token requires HTTPS")
	ErrGeneratorUnavailable         = errors.New("token generator unavailable")
	ErrAuthentication               = errors.New("authentication failed")
	ErrMemberOffline                = errors.New("member offline")
	ErrTargetInvalid                = errors.New("member target invalid")
	ErrTokenGenerationUnsupported   = errors.New("token generation unsupported")
	ErrTokenGenerationRejected      = errors.New("token generation rejected")
	ErrTokenGenerationUnreachable   = errors.New("token generation unreachable")
	ErrTokenGenerationMalformed     = errors.New("token generation response malformed")
)

type FailureReason string

const (
	ReasonOffline                   FailureReason = "offline"
	ReasonSecureEndpointUnavailable FailureReason = "secure-endpoint-unavailable"
	ReasonAuthenticationFailed      FailureReason = "authentication-failed"
	ReasonUnsupportedFirmware       FailureReason = "unsupported-firmware"
	ReasonUnreachable               FailureReason = "unreachable"
)

type Credentials struct {
	Username string
	Password string
}

func DefaultRequestBody() []byte {
	return []byte(`{"probe":"authentication token generate"}`)
}

func DefaultTokenRequestBody() []byte {
	return []byte(`{"authentication":{"token":{"generate":{"user-data":"mndw"}}}}`)
}

type Generator interface {
	Generate(context.Context, enumeration.Member, Credentials) (model.TokenRecord, error)
}

type Outcome struct {
	Member enumeration.Member
	Record model.TokenRecord
	Err    error
	Reason FailureReason
}

func Provision(ctx context.Context, generator Generator, members []enumeration.Member, credentials Credentials) []Outcome {
	outcomes := make([]Outcome, 0, len(members))
	for _, member := range members {
		if err := ctx.Err(); err != nil {
			outcomes = append(outcomes, Outcome{Member: member, Err: err, Reason: ClassifyFailure(err)})
			continue
		}
		if generator == nil {
			outcomes = append(outcomes, Outcome{Member: member, Err: ErrGeneratorUnavailable, Reason: ReasonUnreachable})
			continue
		}
		record, err := generator.Generate(ctx, member, credentials)
		outcome := Outcome{Member: member, Record: record, Err: err}
		if err != nil {
			outcome.Reason = ClassifyFailure(err)
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes
}

func ClassifyFailure(err error) FailureReason {
	if err == nil {
		return ""
	}
	if errors.Is(err, ErrPersistentTokenRequiresHTTPS) || errors.Is(err, ErrTargetInvalid) {
		return ReasonSecureEndpointUnavailable
	}
	if errors.Is(err, ErrMemberOffline) {
		return ReasonOffline
	}
	if errors.Is(err, ErrTokenGenerationRejected) {
		return ReasonAuthenticationFailed
	}
	if errors.Is(err, ErrTokenGenerationUnsupported) {
		return ReasonUnsupportedFirmware
	}
	var authError *auth.AuthError
	if errors.As(err, &authError) {
		switch authError.Kind {
		case auth.ErrorRejected:
			return ReasonAuthenticationFailed
		case auth.ErrorUnsupported:
			return ReasonUnsupportedFirmware
		case auth.ErrorTimeout, auth.ErrorTransport, auth.ErrorMalformed:
			return ReasonUnreachable
		}
	}
	return ReasonUnreachable
}

type Authenticator interface {
	Authenticate(context.Context, auth.Target, auth.Credentials, http.CookieJar) (auth.AuthResult, error)
}

type HTTPGenerator struct {
	Authenticator    Authenticator
	Transport        auth.Transport
	RequestBody      func() []byte
	TokenRequestBody func() []byte
	Logger           *slog.Logger
}

func (g HTTPGenerator) Generate(ctx context.Context, member enumeration.Member, credentials Credentials) (model.TokenRecord, error) {
	if g.Authenticator == nil {
		return g.fail(member, "setup", ErrGeneratorUnavailable)
	}
	if member.FQDN == "" && member.IP == "" {
		return g.fail(member, "target", ErrMemberOffline)
	}
	device, err := target.Resolve(discovery.Member{CID: member.Identity, Name: member.Name, IP: member.IP, FQDN: member.FQDN, MAC: member.MAC})
	if err != nil {
		return g.fail(member, "target", ErrTargetInvalid)
	}
	authResult, err := g.Authenticator.Authenticate(ctx, device.AuthTarget(), auth.Credentials{
		Username: credentials.Username,
		Password: credentials.Password,
	}, nil)
	if err != nil {
		var authError *auth.AuthError
		if errors.As(err, &authError) {
			return g.fail(member, "authentication", errors.Join(ErrAuthentication, err), "endpoint", device.BaseURL)
		}
		return g.fail(member, "authentication", ErrAuthentication, "endpoint", device.BaseURL)
	}
	if g.Logger != nil && authResult.Generation == "x-ndw2-interactive" {
		g.Logger.Info("extender authentication fallback", "identity", member.Identity, "generation", authResult.Generation, "endpoint", device.BaseURL)
	}
	if !device.Secure {
		return g.fail(member, "policy", ErrPersistentTokenRequiresHTTPS, "endpoint", device.BaseURL)
	}
	if g.Transport == nil || g.RequestBody == nil {
		return g.fail(member, "setup", ErrGeneratorUnavailable, "endpoint", device.BaseURL)
	}
	probeResponse, err := g.Transport.Do(ctx, device.AuthTarget(), authResult.Jar, http.MethodPost, "/rci/", g.RequestBody())
	if err != nil {
		return g.fail(member, "token-probe", ErrTokenGenerationUnreachable, "endpoint", device.BaseURL)
	}
	// This is a broad capability probe. A successful HTTP response still needs
	// a found=true payload before the actual token-generation request is sent.
	switch probeResponse.Status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return g.fail(member, "token-probe", ErrTokenGenerationUnsupported, "endpoint", device.BaseURL, "status", probeResponse.Status)
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return g.fail(member, "token-probe", ErrTokenGenerationUnsupported, "endpoint", device.BaseURL, "status", probeResponse.Status)
	default:
		if probeResponse.Status < 200 || probeResponse.Status >= 300 {
			return g.fail(member, "token-probe", ErrTokenGenerationUnreachable, "endpoint", device.BaseURL, "status", probeResponse.Status)
		}
	}
	found, err := parseTokenProbeResponse(probeResponse.Body)
	if err != nil {
		return g.fail(member, "token-probe", ErrTokenGenerationMalformed, "endpoint", device.BaseURL, "status", probeResponse.Status)
	}
	if !found {
		return g.fail(member, "token-probe", ErrTokenGenerationUnsupported, "endpoint", device.BaseURL, "status", probeResponse.Status)
	}

	tokenRequestBody := DefaultTokenRequestBody
	if g.TokenRequestBody != nil {
		tokenRequestBody = g.TokenRequestBody
	}
	response, err := g.Transport.Do(ctx, device.AuthTarget(), authResult.Jar, http.MethodPost, "/rci/", tokenRequestBody())
	if err != nil {
		return g.fail(member, "token-generation", ErrTokenGenerationUnreachable, "endpoint", device.BaseURL)
	}
	// Unlike the broad capability probe, this request runs after /auth and a
	// found=true probe. 401/403 mean generation was refused; 404/405/501 mean
	// the generation command is absent or unsupported.
	switch response.Status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return g.fail(member, "token-generation", ErrTokenGenerationRejected, "endpoint", device.BaseURL, "status", response.Status)
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return g.fail(member, "token-generation", ErrTokenGenerationUnsupported, "endpoint", device.BaseURL, "status", response.Status)
	default:
		if response.Status < 200 || response.Status >= 300 {
			return g.fail(member, "token-generation", ErrTokenGenerationUnreachable, "endpoint", device.BaseURL, "status", response.Status)
		}
	}
	key, token, err := parseTokenGenerationResponse(response.Body)
	if err != nil {
		return g.fail(member, "token-generation", ErrTokenGenerationMalformed, "endpoint", device.BaseURL, "status", response.Status)
	}
	return model.TokenRecord{Key: key, Token: token, Support: model.SupportSupported}, nil
}

func parseTokenProbeResponse(body []byte) (bool, error) {
	probe, err := rci.Extract(body, "probe")
	if err != nil || probe == nil {
		return false, ErrTokenGenerationMalformed
	}
	var probeObject map[string]json.RawMessage
	if err := json.Unmarshal(probe, &probeObject); err != nil || probeObject == nil {
		return false, ErrTokenGenerationMalformed
	}
	found, err := rci.Extract(probe, "found")
	if err != nil {
		return false, ErrTokenGenerationMalformed
	}
	if found == nil {
		return false, nil
	}
	var value bool
	if err := json.Unmarshal(found, &value); err != nil {
		return false, ErrTokenGenerationMalformed
	}
	return value, nil
}

func parseTokenGenerationResponse(body []byte) (string, string, error) {
	generate, err := rci.Extract(body, "authentication.token.generate")
	if err != nil || generate == nil {
		return "", "", ErrTokenGenerationMalformed
	}
	rawID, err := rci.Extract(generate, "id")
	if err != nil || rawID == nil {
		return "", "", ErrTokenGenerationMalformed
	}
	key, err := jsonScalarString(rawID)
	if err != nil {
		return "", "", ErrTokenGenerationMalformed
	}
	rawValue, err := rci.Extract(generate, "value")
	if err != nil || rawValue == nil {
		return "", "", ErrTokenGenerationMalformed
	}
	var token string
	if err := json.Unmarshal(rawValue, &token); err != nil || token == "" {
		return "", "", ErrTokenGenerationMalformed
	}
	return key, token, nil
}

func jsonScalarString(raw json.RawMessage) (string, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err == nil && value != "" {
		return value, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var number json.Number
	if err := decoder.Decode(&number); err != nil || number.String() == "" {
		return "", ErrTokenGenerationMalformed
	}
	return number.String(), nil
}

func (g HTTPGenerator) fail(member enumeration.Member, phase string, err error, extra ...any) (model.TokenRecord, error) {
	if g.Logger != nil {
		attributes := []any{"identity", member.Identity, "phase", phase, "error", err}
		var authError *auth.AuthError
		if errors.As(err, &authError) {
			attributes = append(attributes, "auth_kind", authError.Kind)
		}
		attributes = append(attributes, extra...)
		g.Logger.Warn("extender provisioning failed", attributes...)
	}
	return model.TokenRecord{}, err
}
