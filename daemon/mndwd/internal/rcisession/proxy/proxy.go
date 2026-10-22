// Package proxy forwards a single outbound RCI request to a resolved target and
// returns its response under strict size and time caps.
package proxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mndwd/internal/rcisession/model"
	"mndwd/internal/target"
)

var (
	ErrBadRequest                = errors.New("bad proxy request")
	ErrWriteNotPermitted         = errors.New("write not permitted")
	ErrNoSession                 = errors.New("no session for target")
	ErrUnsupported               = errors.New("target unsupported")
	ErrTargetUnreachable         = errors.New("target unreachable")
	ErrSecureEndpointUnavailable = errors.New("secure endpoint unavailable")
	ErrSessionInvalid            = errors.New("session invalid")
	ErrResponseTooLarge          = errors.New("proxy response too large")
)

type Request struct {
	Target     string
	Method     string
	Path       string
	Body       []byte
	AllowWrite bool
}

type Response struct {
	Status  int
	Headers http.Header
	Body    []byte
}

type Destination struct {
	Controller      bool
	BaseURL         string
	Token           string
	Client          *http.Client
	Support         model.Support
	AllowInsecure   bool
	Generation      uint64
	ControllerEpoch uint64
}

type Resolver interface {
	Resolve(context.Context, string) (Destination, error)
	InvalidateController(uint64)
	Unauthorized(string, uint64)
}

type Proxy struct {
	resolver Resolver
	client   interface {
		Do(*http.Request) (*http.Response, error)
	}
	maxResponse   int64
	operationTime time.Duration
}

func New(resolver Resolver, client interface {
	Do(*http.Request) (*http.Response, error)
}, maxResponse int64, operationTime time.Duration) *Proxy {
	if client == nil {
		client = &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	}

	if maxResponse <= 0 {
		maxResponse = 1 << 20
	}

	return &Proxy{resolver: resolver, client: client, maxResponse: maxResponse, operationTime: operationTime}
}

func (p *Proxy) Do(ctx context.Context, request Request) (Response, error) {
	if !validMethod(request.Method) {
		return Response{}, fmt.Errorf("%w: invalid method", ErrBadRequest)
	}

	if err := target.ValidateRCIPath(request.Path); err != nil {
		return Response{}, fmt.Errorf("%w: invalid path", ErrBadRequest)
	}

	if target.Classify(request.Method, request.Path, request.Body) == target.AccessWrite && !request.AllowWrite {
		return Response{}, ErrWriteNotPermitted
	}

	if p.resolver == nil {
		return Response{}, fmt.Errorf("%w: resolver unavailable", ErrTargetUnreachable)
	}

	destination, err := p.resolver.Resolve(ctx, request.Target)
	if err != nil {
		return Response{}, errors.Join(ErrTargetUnreachable, err)
	}

	if destination.Support == model.SupportUnsupported {
		return Response{}, ErrUnsupported
	}

	isController := destination.Controller

	if destination.Support == "" || (!isController && destination.Client == nil) {
		return Response{}, ErrNoSession
	}

	endpoint, err := url.Parse(strings.TrimRight(destination.BaseURL, "/") + "/" + request.Path)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return Response{}, fmt.Errorf("%w: invalid target URL", ErrBadRequest)
	}

	if strings.EqualFold(endpoint.Scheme, "http") && !destination.AllowInsecure {
		return Response{}, ErrSecureEndpointUnavailable
	}

	if !strings.EqualFold(endpoint.Scheme, "http") && !strings.EqualFold(endpoint.Scheme, "https") {
		return Response{}, fmt.Errorf("%w: unsupported target scheme", ErrBadRequest)
	}

	requestCtx := ctx
	var cancel context.CancelFunc

	if p.operationTime > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, p.operationTime)

		defer cancel()
	}

	outbound, err := http.NewRequestWithContext(requestCtx, request.Method, endpoint.String(), bytes.NewReader(request.Body))
	if err != nil {
		return Response{}, fmt.Errorf("%w: invalid outbound request", ErrBadRequest)
	}

	if len(request.Body) > 0 {
		outbound.Header.Set("Content-Type", "application/json")
	}

	outbound.Header.Set("Accept", "application/json")

	if isController && destination.Token != "" {
		outbound.Header.Set("X-Ndma-Tkn", destination.Token)
	}

	client := p.client

	if !isController {
		client = destination.Client
	}

	response, err := client.Do(outbound)
	if err != nil {
		return Response{}, fmt.Errorf("%w: outbound request failed", ErrTargetUnreachable)
	}

	defer response.Body.Close()

	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return Response{}, fmt.Errorf("%w: redirect rejected", ErrTargetUnreachable)
	}

	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		if isController {
			p.resolver.InvalidateController(destination.ControllerEpoch)
		} else {
			p.resolver.Unauthorized(request.Target, destination.Generation)
		}

		return Response{}, ErrSessionInvalid
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, p.maxResponse+1))
	if err != nil {
		return Response{}, fmt.Errorf("%w: response read failed", ErrTargetUnreachable)
	}

	if int64(len(body)) > p.maxResponse {
		return Response{}, ErrResponseTooLarge
	}

	return Response{Status: response.StatusCode, Headers: response.Header.Clone(), Body: body}, nil
}

func validMethod(method string) bool {
	if method == "" {
		return false
	}

	for index := 0; index < len(method); index++ {
		character := method[index]

		if character <= 0x20 || character >= 0x7f || strings.ContainsRune("()<>@,;:\\\"/[]?={} \t", rune(character)) {
			return false
		}
	}

	return true
}
