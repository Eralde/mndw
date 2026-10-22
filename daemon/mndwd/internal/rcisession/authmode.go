package rcisession

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AuthMode describes whether controller RCI requests require a token.
type AuthMode string

const (
	AuthModeToken   AuthMode = "token"
	AuthModeNone    AuthMode = "none"
	AuthModeUnknown AuthMode = "unknown"
)

const authModeProbeBody = `{"probe":"authentication token generate"}`

// AuthModeDetector probes the controller once until it gets a known mode.
// Unknown results are deliberately not cached so later calls can recover.
type AuthModeDetector struct {
	Client  *http.Client
	BaseURL string
	Timeout time.Duration

	mu   sync.Mutex
	mode AuthMode
}

// Mode returns the last known auth mode without making a request.
func (d *AuthModeDetector) Mode() AuthMode {
	d.mu.Lock()

	defer d.mu.Unlock()

	if d.mode == "" {
		return AuthModeUnknown
	}

	return d.mode
}

// Detect returns a cached known mode or probes the controller without a token.
func (d *AuthModeDetector) Detect(ctx context.Context) AuthMode {
	if mode := d.Mode(); mode != AuthModeUnknown {
		return mode
	}

	mode := d.probe(ctx)

	if mode == AuthModeUnknown {
		return mode
	}

	d.mu.Lock()

	defer d.mu.Unlock()

	if d.mode == "" || d.mode == AuthModeUnknown {
		d.mode = mode
	}

	return d.mode
}

func (d *AuthModeDetector) probe(ctx context.Context) AuthMode {
	requestContext := ctx
	var cancel context.CancelFunc

	if d.Timeout > 0 {
		requestContext, cancel = context.WithTimeout(ctx, d.Timeout)

		defer cancel()
	}

	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, strings.TrimRight(d.BaseURL, "/")+"/rci/", strings.NewReader(authModeProbeBody))
	if err != nil {
		return AuthModeUnknown
	}

	request.Header.Set("Content-Type", "application/json")

	client := d.Client

	if client == nil {
		client = http.DefaultClient
	}

	response, err := client.Do(request)
	if err != nil {
		return AuthModeUnknown
	}

	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return AuthModeToken
	case http.StatusOK:
		body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
		if err != nil || len(body) > 64<<10 {
			return AuthModeUnknown
		}

		var object map[string]json.RawMessage

		if err := json.Unmarshal(body, &object); err != nil || object == nil {
			return AuthModeUnknown
		}

		probeJSON, hasProbe := object["probe"]

		if !hasProbe {
			return AuthModeNone
		}

		var probe map[string]json.RawMessage

		if err := json.Unmarshal(probeJSON, &probe); err != nil || probe == nil {
			return AuthModeUnknown
		}

		foundJSON, hasFound := probe["found"]

		if !hasFound {
			return AuthModeUnknown
		}

		var found bool

		if err := json.Unmarshal(foundJSON, &found); err != nil {
			return AuthModeUnknown
		}

		if found {
			return AuthModeToken
		}

		return AuthModeNone
	default:
		return AuthModeUnknown
	}
}
