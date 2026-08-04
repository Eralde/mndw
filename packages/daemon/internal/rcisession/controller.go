package rcisession

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const DefaultControllerURL = "http://127.0.0.1:79"

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
