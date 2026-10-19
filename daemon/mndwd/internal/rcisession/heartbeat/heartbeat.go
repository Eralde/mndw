package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Result struct {
	Status       int
	Err          error
	Transient    bool
	Unauthorized bool
}

type Target struct {
	Identity   string
	Client     *http.Client
	Generation uint64
	Context    context.Context
}

type baseURLContextKey struct{}

func WithBaseURL(ctx context.Context, baseURL string) context.Context {
	return context.WithValue(ctx, baseURLContextKey{}, baseURL)
}

func baseURL(ctx context.Context) string {
	if value, ok := ctx.Value(baseURLContextKey{}).(string); ok {
		return value
	}

	return ""
}

type Probe struct {
	Timeout          time.Duration
	MaxResponseBytes int64
}

func (p Probe) Run(ctx context.Context, client *http.Client, baseURL string) Result {
	if client == nil {
		return Result{Err: context.Canceled, Transient: true}
	}

	if p.Timeout <= 0 {
		p.Timeout = 5 * time.Second
	}

	if p.MaxResponseBytes <= 0 {
		p.MaxResponseBytes = 1 << 20
	}

	requestContext, cancel := context.WithTimeout(ctx, p.Timeout)

	defer cancel()

	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, strings.TrimRight(baseURL, "/")+"/rci/", bytes.NewReader([]byte(`{"show":{"version":{}}}`)))
	if err != nil {
		return Result{Err: err, Transient: true}
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return Result{Err: err, Transient: true}
	}

	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return Result{Status: response.StatusCode, Unauthorized: true}
	}

	body, readErr := io.ReadAll(io.LimitReader(response.Body, p.MaxResponseBytes+1))

	if readErr != nil || int64(len(body)) > p.MaxResponseBytes {
		if readErr == nil {
			readErr = io.ErrShortBuffer
		}

		return Result{Status: response.StatusCode, Err: readErr, Transient: true}
	}

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices || !json.Valid(bytes.TrimSpace(body)) {
		return Result{Status: response.StatusCode, Transient: true}
	}

	return Result{Status: response.StatusCode}
}

func RunBounded(ctx context.Context, targets []Target, workers int, probe Probe, commit func(Target, Result)) {
	if len(targets) == 0 || commit == nil {
		return
	}

	if workers <= 0 {
		workers = 1
	}

	if workers > len(targets) {
		workers = len(targets)
	}

	jobs := make(chan Target)
	var wait sync.WaitGroup

	wait.Add(workers)

	for index := 0; index < workers; index++ {
		go func() {
			defer wait.Done()

			for target := range jobs {
				if target.Context == nil {
					target.Context = context.Background()
				}

				select {
				case <-ctx.Done():
					return
				case <-target.Context.Done():
					continue
				default:
				}

				requestContext, cancel := context.WithCancel(ctx)
				stop := context.AfterFunc(target.Context, cancel)
				result := probe.Run(requestContext, target.Client, baseURL(target.Context))

				stop()
				cancel()
				commit(target, result)
			}
		}()
	}

	for _, target := range targets {
		select {
		case <-ctx.Done():
			close(jobs)
			wait.Wait()

			return
		case jobs <- target:
		}
	}

	close(jobs)
	wait.Wait()
}
