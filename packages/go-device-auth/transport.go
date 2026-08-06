package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

const (
	defaultIOTimeout   = 5 * time.Second
	defaultMaxResponse = 512 << 10
	maxRequestBody     = 128 << 10
	legacySchema       = "x-ndw2-interactive"
	scramSchema        = "x-ndw4-interactive"
	authPath           = "/auth"
	ndw4ReplyHeader    = "X-NDM-Data"
	ndw4ClientKey      = "NDW4 Interactive Client Key"
	ndw4ServerKey      = "NDW4 Interactive Server Key"
	ndw4SaltLength     = 16
	ndw4HashLength     = 64
	ndw4Parallelism    = 1
	ndw4MaxIterations  = 64
	ndw4MinMemoryKiB   = 8
	ndw4MaxMemoryKiB   = 262144
)

// Target is a controller or extender endpoint selected by trusted discovery.
// BaseURL must not come from a browser request.
type Target struct {
	BaseURL string
}

// Credentials is consumed synchronously by Authenticate. Password is copied to
// a mutable buffer and wiped when the handshake returns.
type Credentials struct {
	Username string
	Password string
}

// Response is the small transport surface needed by the auth protocols.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Transport permits deterministic protocol tests and keeps HTTP policy outside
// the auth transcript code.
type Transport interface {
	Do(ctx context.Context, target Target, jar http.CookieJar, method, path string, body []byte) (Response, error)
}

// HTTPTransport is the production transport. It never follows redirects and
// bounds every response before handing it to an auth protocol.
type HTTPTransport struct {
	Client           *http.Client
	IOTimeout        time.Duration
	MaxResponseBytes int64
}

// NewHTTPTransport returns a transport with the daemon's safe defaults.
func NewHTTPTransport(client *http.Client) *HTTPTransport {
	if client == nil {
		client = &http.Client{}
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}

	return &HTTPTransport{Client: client, IOTimeout: defaultIOTimeout, MaxResponseBytes: defaultMaxResponse}
}

func (t *HTTPTransport) Do(ctx context.Context, target Target, jar http.CookieJar, method, path string, body []byte) (Response, error) {
	if len(body) > maxRequestBody {
		return Response{}, fmt.Errorf("auth request exceeds size limit")
	}
	base, err := url.Parse(target.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return Response{}, &AuthError{Kind: ErrorUnsupported, Err: fmt.Errorf("invalid auth target")}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(path, "/")

	requestCtx := ctx
	if t.IOTimeout <= 0 {
		t.IOTimeout = defaultIOTimeout
	}
	var cancel context.CancelFunc
	requestCtx, cancel = context.WithTimeout(requestCtx, t.IOTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, method, base.String(), strings.NewReader(string(body)))
	if err != nil {
		return Response{}, err
	}
	req.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	client := *t.Client
	client.Jar = jar
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			return Response{}, &AuthError{Kind: ErrorTimeout, Err: err}
		}
		return Response{}, &AuthError{Kind: ErrorTransport, Err: err}
	}
	defer resp.Body.Close()

	limit := t.MaxResponseBytes
	if limit <= 0 {
		limit = defaultMaxResponse
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return Response{}, &AuthError{Kind: ErrorTransport, Err: err}
	}
	if int64(len(data)) > limit {
		return Response{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("auth response exceeds size limit")}
	}

	return Response{Status: resp.StatusCode, Header: resp.Header.Clone(), Body: data}, nil
}

func newJar(jar http.CookieJar) (http.CookieJar, error) {
	if jar != nil {
		return jar, nil
	}
	return cookiejar.New(nil)
}

func decodeJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return &AuthError{Kind: ErrorMalformed, Err: err}
	}
	return nil
}
