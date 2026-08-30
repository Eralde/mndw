// Package deviceproxy reverse-proxies browser-facing device routes.
package deviceproxy

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

type contextKey struct{}

var incomingHostKey contextKey

// New builds a device reverse-proxy handler. It preserves the incoming path,
// rewrites the upstream Host, rewrites only matching Location authorities back
// to the incoming host, and leaves streaming response bodies unbounded.
func New(deviceURL string, logger *slog.Logger) (http.Handler, error) {
	target, err := url.Parse(deviceURL)
	if err != nil {
		return nil, err
	}

	if target.Scheme == "" || target.Host == "" {
		return nil, &url.Error{Op: "parse", URL: deviceURL, Err: errBadDeviceTarget}
	}

	if logger == nil {
		logger = slog.Default()
	}

	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Rewrite: func(request *httputil.ProxyRequest) {
			incomingHost := request.In.Host
			incomingPath := request.In.URL.Path
			incomingRawPath := request.In.URL.RawPath
			incomingRawQuery := request.In.URL.RawQuery

			request.SetURL(target)

			request.Out.URL.Path = incomingPath
			request.Out.URL.RawPath = incomingRawPath
			request.Out.URL.RawQuery = incomingRawQuery
			request.Out.Host = target.Host
			request.Out = request.Out.WithContext(context.WithValue(request.Out.Context(), incomingHostKey, incomingHost))
		},
		ModifyResponse: func(response *http.Response) error {
			incomingHost, _ := response.Request.Context().Value(incomingHostKey).(string)

			if incomingHost == "" {
				return nil
			}

			location := response.Header.Get("Location")

			if location == "" {
				return nil
			}

			locationURL, err := url.Parse(location)
			if err != nil || !sameDeviceHost(locationURL, target) {
				return nil
			}

			locationURL.Host = incomingHost

			response.Header.Set("Location", locationURL.String())

			return nil
		},
		ErrorHandler: func(writer http.ResponseWriter, request *http.Request, proxyErr error) {
			logger.Warn("device proxy error", "path", request.URL.Path, "error", proxyErr)
			writer.WriteHeader(http.StatusBadGateway)
		},
	}

	proxy.Transport = &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConns:          16,
		IdleConnTimeout:       90 * time.Second,
	}

	return proxy, nil
}

func sameDeviceHost(candidate, target *url.URL) bool {
	return strings.EqualFold(candidate.Hostname(), target.Hostname()) &&
		effectivePort(candidate, target.Scheme) == effectivePort(target, target.Scheme)
}

func effectivePort(value *url.URL, defaultScheme string) string {
	if port := value.Port(); port != "" {
		return port
	}

	scheme := value.Scheme

	if scheme == "" {
		scheme = defaultScheme
	}

	switch strings.ToLower(scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

type badDeviceTarget struct{}

func (badDeviceTarget) Error() string { return "device URL missing scheme or host" }

var errBadDeviceTarget = badDeviceTarget{}
