package establisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"

	rci "mndw.local/rci"
	"mndwd/internal/httpx"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/target"
)

type ControllerAuthURLer interface {
	AuthURL(context.Context, string) (string, uint64, error)
}

type AuthURLResponseError struct{}

func (AuthURLResponseError) Error() string { return "controller auth-url response malformed" }

type StaleControllerResultError struct{}

func (StaleControllerResultError) Error() string { return "controller auth-url result stale" }

type EstablishResult struct {
	BaseURL string
	Jar     http.CookieJar
	Client  *http.Client
}

type EstablishError struct {
	Kind  string
	Epoch uint64
}

func (e EstablishError) Error() string { return "extender establishment " + e.Kind }

type Establisher struct {
	AuthURLer        ControllerAuthURLer
	HTTPClient       *http.Client
	MaxResponseBytes int64
}

func ValidateAuthURL(rawURL string, memberFQDN string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.Path != "/auth" {
		return nil, fmt.Errorf("validation failed")
	}

	if parsed.Port() != "" && parsed.Port() != "443" {
		return nil, fmt.Errorf("validation failed")
	}

	want, err := target.NormalizeFQDN(memberFQDN)
	if err != nil {
		return nil, fmt.Errorf("validation failed")
	}

	host, err := target.NormalizeFQDN(parsed.Hostname())
	if err != nil || host != want || parsed.Query().Get("x-ndma-tkn") == "" {
		return nil, fmt.Errorf("validation failed")
	}

	return parsed, nil
}

func (e *Establisher) Establish(ctx context.Context, member enumeration.Member) (EstablishResult, error) {
	if e.AuthURLer == nil {
		return EstablishResult{}, EstablishError{Kind: "controller-unavailable"}
	}

	rawURL, epoch, err := e.AuthURLer.AuthURL(ctx, member.Identity)
	if err != nil {
		var malformed AuthURLResponseError

		if errors.As(err, &malformed) {
			return EstablishResult{}, EstablishError{Kind: "malformed-response", Epoch: epoch}
		}

		var stale StaleControllerResultError

		if errors.As(err, &stale) {
			return EstablishResult{}, EstablishError{Kind: "stale", Epoch: epoch}
		}

		var httpError *rci.HTTPError

		if errors.As(err, &httpError) && (httpError.StatusCode == http.StatusUnauthorized || httpError.StatusCode == http.StatusForbidden) {
			return EstablishResult{}, EstablishError{Kind: "unauthorized", Epoch: epoch}
		}

		return EstablishResult{}, EstablishError{Kind: "controller-unavailable", Epoch: epoch}
	}

	validated, err := ValidateAuthURL(rawURL, member.FQDN)
	if err != nil {
		return EstablishResult{}, EstablishError{Kind: "validation", Epoch: epoch}
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		return EstablishResult{}, EstablishError{Kind: "redemption-failed", Epoch: epoch}
	}

	client := &http.Client{Jar: jar, CheckRedirect: httpx.NoRedirect}

	if e.HTTPClient != nil {
		clone := *e.HTTPClient
		clone.Jar = jar
		clone.CheckRedirect = httpx.NoRedirect
		client = &clone
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, validated.String(), nil)
	if err != nil {
		return EstablishResult{}, EstablishError{Kind: "validation", Epoch: epoch}
	}

	response, err := client.Do(request)
	if err != nil {
		return EstablishResult{}, EstablishError{Kind: "transient", Epoch: epoch}
	}

	defer response.Body.Close()

	limit := e.MaxResponseBytes

	if limit <= 0 {
		limit = 1 << 20
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return EstablishResult{}, EstablishError{Kind: "redemption-failed", Epoch: epoch}
	}

	if response.StatusCode != http.StatusOK {
		return EstablishResult{}, EstablishError{Kind: "redemption-failed", Epoch: epoch}
	}

	dynamicCookie := false

	for _, cookie := range response.Cookies() {
		if strings.HasPrefix(cookie.Name, "__Host-") {
			dynamicCookie = true

			break
		}
	}

	if !dynamicCookie {
		return EstablishResult{}, EstablishError{Kind: "redemption-failed", Epoch: epoch}
	}

	return EstablishResult{BaseURL: "https://" + targetHost(validated), Jar: jar, Client: client}, nil
}

func targetHost(value *url.URL) string {
	host, err := target.NormalizeFQDN(value.Hostname())
	if err != nil {
		return strings.ToLower(value.Hostname())
	}

	return host
}

func parseAuthURLBody(body []byte) (string, error) {
	var direct map[string]json.RawMessage

	if err := json.Unmarshal(body, &direct); err == nil && direct != nil {
		if value, ok := direct["url"]; ok {
			var rawURL string

			if err := json.Unmarshal(value, &rawURL); err == nil && rawURL != "" {
				return rawURL, nil
			}
		}
	}

	var envelope []json.RawMessage

	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope) == 0 {
		return "", fmt.Errorf("malformed auth-url response")
	}

	value, err := rci.Extract(envelope[0], "mws.member.auth-url.url")
	if err != nil || value == nil {
		return "", fmt.Errorf("malformed auth-url response")
	}

	var rawURL string

	if err := json.Unmarshal(value, &rawURL); err != nil || rawURL == "" {
		return "", fmt.Errorf("malformed auth-url response")
	}

	return rawURL, nil
}

// ParseAuthURLResponse accepts either the extracted auth-url object or a raw
// controller response envelope. It returns only the URL value.
func ParseAuthURLResponse(body []byte) (string, error) { return parseAuthURLBody(body) }
