package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
)

const defaultLiveDiagnosticsBytes int64 = 256 * 1024

// LiveDiagnostics performs one bounded request to a ready service's private
// diagnostics route. It returns only the JSON body; daemon-owned redaction and
// aggregate accounting remain in internal/diagnostics.
func (s *Supervisor) LiveDiagnostics(ctx context.Context, pluginID string) ([]byte, error) {
	if s.Status(pluginID).State != StateReady {
		return nil, fmt.Errorf("service is not ready")
	}

	socketPath, ok := s.SocketPath(pluginID)

	if !ok {
		return nil, fmt.Errorf("service is not known")
	}

	timeout := s.cfg.DiagnosticsTimeout

	if timeout <= 0 {
		timeout = 2 * time.Second
	}

	requestContext, cancel := context.WithTimeout(ctx, timeout)

	defer cancel()

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	defer transport.CloseIdleConnections()

	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, "http://mndw/_mndw/diagnostics", nil)
	if err != nil {
		return nil, err
	}

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", response.StatusCode)
	}

	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return nil, fmt.Errorf("response content type is not application/json")
	}

	maxBytes := defaultLiveDiagnosticsBytes

	if response.ContentLength > maxBytes {
		return nil, fmt.Errorf("response exceeds %d bytes", maxBytes)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response exceeds %d bytes", maxBytes)
	}

	if err := validateDiagnosticsObject(body); err != nil {
		return nil, err
	}

	return body, nil
}

func validateDiagnosticsObject(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	var value any

	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("response is not JSON: %w", err)
	}

	var extra any

	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("response has trailing JSON")
		}

		return fmt.Errorf("response has trailing data: %w", err)
	}

	if _, ok := value.(map[string]any); !ok {
		return fmt.Errorf("response JSON must be an object")
	}

	return nil
}
