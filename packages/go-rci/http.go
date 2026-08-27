package rci

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
)

type HTTPOption func(*httpTransport)

type httpHeader struct {
	name  string
	value func() string
}

type httpTransport struct {
	endpoint         *url.URL
	client           *http.Client
	headers          []httpHeader
	maxResponseBytes int64
	optionErr        error
}

func (t *httpTransport) Send(ctx context.Context, body []byte) (Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, t.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	for _, header := range t.headers {
		if header.value != nil {
			request.Header.Set(header.name, header.value())
		}
	}

	client := *t.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := client.Do(request)
	if err != nil {
		return Response{}, err
	}
	defer response.Body.Close()

	var reader io.Reader = response.Body
	if response.StatusCode != http.StatusOK {
		reader = io.LimitReader(response.Body, 4<<10)
	} else if t.maxResponseBytes > 0 && t.maxResponseBytes < math.MaxInt64 {
		reader = io.LimitReader(response.Body, t.maxResponseBytes+1)
	}

	responseBody, err := io.ReadAll(reader)
	if err != nil {
		return Response{}, err
	}
	if response.StatusCode == http.StatusOK && t.maxResponseBytes > 0 &&
		t.maxResponseBytes < math.MaxInt64 && int64(len(responseBody)) > t.maxResponseBytes {
		return Response{}, fmt.Errorf("%w: limit %d bytes", ErrResponseTooLarge, t.maxResponseBytes)
	}
	return Response{Status: response.StatusCode, Body: responseBody}, nil
}

func WithHTTPClient(client *http.Client) HTTPOption {
	return func(transport *httpTransport) {
		if client == nil {
			if transport.optionErr == nil {
				transport.optionErr = ErrNilHTTPClient
			}
			return
		}
		transport.client = client
	}
}

func WithHeader(name string, value func() string) HTTPOption {
	return func(transport *httpTransport) {
		transport.headers = append(transport.headers, httpHeader{name: name, value: value})
	}
}

func WithMaxResponseBytes(maxBytes int64) HTTPOption {
	return func(transport *httpTransport) {
		transport.maxResponseBytes = maxBytes
	}
}

func NewHTTPTransport(baseURL string, opts ...HTTPOption) (Transport, error) {
	endpoint, err := normalizeBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	transport := &httpTransport{
		endpoint:         endpoint,
		client:           &http.Client{},
		maxResponseBytes: 16 << 20,
	}
	for _, option := range opts {
		if option != nil {
			option(transport)
		}
	}
	if transport.optionErr != nil {
		return nil, transport.optionErr
	}
	return transport, nil
}

func normalizeBaseURL(baseURL string) (*url.URL, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidBaseURL, err)
	}
	if scheme := strings.ToLower(base.Scheme); scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("%w: unsupported scheme", ErrInvalidBaseURL)
	}
	if base.Hostname() == "" {
		return nil, fmt.Errorf("%w: empty host", ErrInvalidBaseURL)
	}
	if base.User != nil {
		return nil, fmt.Errorf("%w: userinfo is not allowed", ErrInvalidBaseURL)
	}
	if base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("%w: query and fragment are not allowed", ErrInvalidBaseURL)
	}
	if hasDotPathSegment(base) {
		return nil, fmt.Errorf("%w: dot path segment", ErrInvalidBaseURL)
	}
	return base.JoinPath("rci/"), nil
}

func hasDotPathSegment(base *url.URL) bool {
	for _, segment := range strings.Split(base.Path, "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	for _, segment := range strings.Split(base.EscapedPath(), "/") {
		decoded, err := url.PathUnescape(segment)
		if err == nil && (decoded == "." || decoded == "..") {
			return true
		}
	}
	return false
}
