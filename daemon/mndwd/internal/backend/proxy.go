package backend

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mndwd/internal/httpx"
)

type serviceProxyCommittedError struct {
	err error
}

func (e *serviceProxyCommittedError) Error() string { return e.err.Error() }

func (e *serviceProxyCommittedError) Unwrap() error { return e.err }

func filteredServiceHeaders(source http.Header) http.Header {
	filtered := make(http.Header)

	for _, key := range []string{"Accept", "Content-Type", "Content-Length", "If-None-Match", "If-Modified-Since", "Range", "User-Agent"} {
		for _, value := range source.Values(key) {
			filtered.Add(key, value)
		}
	}

	return filtered
}

func proxyServiceHTTP(ctx context.Context, writer http.ResponseWriter, request *http.Request, socketPath, pluginID, routeID, routePath string, timeout time.Duration) error {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: httpx.NoRedirect}

	defer transport.CloseIdleConnections()

	path := "/" + strings.TrimPrefix(routePath, "/")
	uri := &url.URL{Scheme: "http", Host: "mndw", Path: path, RawQuery: request.URL.RawQuery}
	upstreamRequest, err := http.NewRequestWithContext(ctx, request.Method, uri.String(), request.Body)
	if err != nil {
		return err
	}

	upstreamRequest.Header = filteredServiceHeaders(request.Header)

	upstreamRequest.Header.Set("X-Mndw-Plugin-Id", pluginID)
	upstreamRequest.Header.Set("X-Mndw-Route-Id", routeID)

	response, err := client.Do(upstreamRequest)
	if err != nil {
		return err
	}

	defer response.Body.Close()

	for key, values := range response.Header {
		if forbiddenResponseHeader(key) {
			continue
		}

		for _, value := range values {
			writer.Header().Add(key, value)
		}
	}

	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(response.StatusCode)

	_, copyErr := io.Copy(writer, response.Body)

	if copyErr != nil {
		return &serviceProxyCommittedError{err: copyErr}
	}

	return nil
}

func serviceProxyResponseCommitted(err error) bool {
	var committedErr *serviceProxyCommittedError

	return errors.As(err, &committedErr)
}
