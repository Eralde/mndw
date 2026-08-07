package rcisession

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mndwd/internal/rcisession/model"
)

const DefaultControllerURL = "http://127.0.0.1:79"

// ValidateControllerURLShape parses raw (without trimming) and enforces the
// controller-URL shape shared by the daemon flag and the session service: an
// absolute HTTP(S) URL carrying only a scheme and host — no userinfo, query,
// fragment, or path beyond "/". It returns the parsed URL on success. Callers
// layer their own policy (whitespace trimming, default-filling, loopback/remote
// rules) on top.
func ValidateControllerURLShape(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" {
		return nil, fmt.Errorf("controller URL must be an absolute HTTP(S) URL, got %q", raw)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, fmt.Errorf("controller URL must contain only scheme and host, got %q", raw)
	}

	return parsed, nil
}

// IsLoopbackHost reports whether host is a loopback IP literal.
func IsLoopbackHost(host string) bool {
	ip := net.ParseIP(host)

	return ip != nil && ip.IsLoopback()
}

type ControllerHTTPTester struct {
	Client  *http.Client
	Timeout time.Duration
	BaseURL string
}

func (t ControllerHTTPTester) Test(ctx context.Context, token string) (ControllerVerdict, error) {
	client := t.Client
	if client == nil {
		client = &http.Client{}
	}
	requestContext := ctx
	var cancel context.CancelFunc
	if t.Timeout > 0 {
		requestContext, cancel = context.WithTimeout(ctx, t.Timeout)
		defer cancel()
	}
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, strings.TrimRight(controllerURL(t.BaseURL), "/")+"/rci/show/version", nil)
	if err != nil {
		return ControllerUnreachable, fmt.Errorf("build controller test request: %w", err)
	}
	request.Header.Set("X-Ndma-Tkn", token)
	response, err := client.Do(request)
	if err != nil {
		return ControllerUnreachable, fmt.Errorf("controller test request failed")
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, 512<<10)
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return ControllerInvalidToken, nil
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return ControllerUnsupported, nil
	case http.StatusOK:
		return ControllerValid, nil
	default:
		if response.StatusCode >= 500 || response.StatusCode == http.StatusRequestTimeout {
			return ControllerUnreachable, fmt.Errorf("controller test returned status")
		}
		return ControllerInvalidToken, nil
	}
}

func controllerURL(baseURL string) string {
	if strings.TrimSpace(baseURL) == "" {
		return DefaultControllerURL
	}

	return strings.TrimRight(baseURL, "/")
}

type ControllerVerdict string

const (
	ControllerValid        ControllerVerdict = "valid"
	ControllerInvalidToken ControllerVerdict = "invalid-token"
	ControllerUnsupported  ControllerVerdict = "unsupported-firmware"
	ControllerUnreachable  ControllerVerdict = "unreachable"
)

type ControllerTester interface {
	Test(context.Context, string) (ControllerVerdict, error)
}

func (s *Service) TestController(ctx context.Context, tester ControllerTester, token string) (ControllerVerdict, error) {
	if token == "" {
		return ControllerInvalidToken, nil
	}
	if tester == nil {
		return ControllerUnreachable, fmt.Errorf("controller tester unavailable")
	}
	return tester.Test(ctx, token)
}

func (s *Service) SaveController(ctx context.Context, tester ControllerTester, token string) (ControllerVerdict, error) {
	verdict, err := s.TestController(ctx, tester, token)
	if err != nil || verdict != ControllerValid {
		return verdict, err
	}
	checked := s.now().UTC()
	if err := s.store.ReplaceController(model.TokenRecord{
		Key:           "controller",
		Token:         token,
		Support:       model.SupportSupported,
		LastCheckedAt: &checked,
	}); err != nil {
		return ControllerUnreachable, err
	}
	s.notifyMutation("controller-token-saved")
	return verdict, nil
}

func (s *Service) DeleteController() error {
	if err := s.store.DeleteController(); err != nil {
		return err
	}
	s.notifyMutation("controller-token-deleted")
	return nil
}
