package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

const readinessBodyLimit = 64 << 10
const readinessRetryInterval = 25 * time.Millisecond

func ProbeReadiness(ctx context.Context, socketPath, pluginID string, protocolVersion int, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	readinessCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dialer := &net.Dialer{}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: timeout}
	defer transport.CloseIdleConnections()

	return retryReadiness(readinessCtx, func(requestContext context.Context) (bool, error) {
		request, err := http.NewRequestWithContext(requestContext, http.MethodGet, "http://mndw/_mndw/ready", nil)
		if err != nil {
			return false, err
		}
		response, err := client.Do(request)
		if err != nil {
			return true, fmt.Errorf("readiness request: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return false, fmt.Errorf("readiness status %d", response.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, readinessBodyLimit+1))
		if err != nil {
			return false, fmt.Errorf("readiness body: %w", err)
		}
		if len(body) > readinessBodyLimit {
			return false, fmt.Errorf("readiness response exceeds limit")
		}
		var ready struct {
			PluginID        string `json:"pluginId"`
			ProtocolVersion int    `json:"protocolVersion"`
		}
		if err := json.Unmarshal(body, &ready); err != nil {
			return false, fmt.Errorf("readiness response is not JSON: %w", err)
		}
		if ready.PluginID != pluginID || ready.ProtocolVersion != protocolVersion {
			return false, fmt.Errorf("readiness identity mismatch")
		}

		return false, nil
	})
}

func retryReadiness(ctx context.Context, attempt func(context.Context) (bool, error)) error {
	var lastErr error
	for {
		retry, err := attempt(ctx)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			return lastErr
		}
		timer := time.NewTimer(readinessRetryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return lastErr
		case <-timer.C:
		}
	}
}
