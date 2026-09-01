package deviceinfo

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxConstantsBytes   = 256 << 10
	defaultFetchTimeout = 5 * time.Second
)

type Fetcher interface {
	Fetch(context.Context, string) (Snapshot, error)
}

type FetcherOptions struct {
	Client   *http.Client
	MaxBytes int64
}

type HTTPFetcher struct {
	url      string
	client   *http.Client
	maxBytes int64
	logger   *slog.Logger
}

func NewHTTPFetcher(deviceURL string, logger *slog.Logger, options FetcherOptions) (*HTTPFetcher, error) {
	parsed, err := url.Parse(strings.TrimSpace(deviceURL))
	if err != nil {
		return nil, fmt.Errorf("parse device URL: %w", err)
	}

	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("device URL must include scheme and host")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/ndmConstants.json"
	parsed.RawQuery = ""
	parsed.Fragment = ""

	client := options.Client

	if client == nil {
		client = &http.Client{Timeout: defaultFetchTimeout}
	}

	maxBytes := options.MaxBytes

	if maxBytes <= 0 {
		maxBytes = maxConstantsBytes
	}

	return &HTTPFetcher{url: parsed.String(), client: client, maxBytes: maxBytes, logger: logger}, nil
}

func (f *HTTPFetcher) Fetch(ctx context.Context, cookie string) (Snapshot, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return Snapshot{}, fmt.Errorf("build ndmConstants request: %w", err)
	}

	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}

	response, err := f.client.Do(request)
	if err != nil {
		f.logFailure("fetch ndmConstants", err)

		return Snapshot{}, fmt.Errorf("fetch ndmConstants: %w", err)
	}

	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		err := fmt.Errorf("device returned HTTP %d", response.StatusCode)

		f.logFailure("fetch ndmConstants", err)

		return Snapshot{}, err
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, f.maxBytes+1))
	if err != nil {
		f.logFailure("read ndmConstants", err)

		return Snapshot{}, fmt.Errorf("read ndmConstants: %w", err)
	}

	if int64(len(data)) > f.maxBytes {
		err := fmt.Errorf("ndmConstants response exceeds %d bytes", f.maxBytes)

		f.logFailure("read ndmConstants", err)

		return Snapshot{}, err
	}

	snapshot, err := parseConstants(data)
	if err != nil {
		f.logFailure("parse ndmConstants", err)

		return Snapshot{}, err
	}

	return snapshot, nil
}

func (f *HTTPFetcher) logFailure(message string, err error) {
	if f.logger != nil {
		f.logger.Warn(message, "error", err)
	}
}
