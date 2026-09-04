package telemetry

import (
	"context"
	"net/http"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/proxy"
)

type DoFunc func(context.Context, proxy.Request) (proxy.Response, error)

type controllerTransport struct {
	do DoFunc
}

func NewControllerTransport(do DoFunc) *controllerTransport {
	return &controllerTransport{do: do}
}

func (t *controllerTransport) Send(ctx context.Context, body []byte) (rci.Response, error) {
	response, err := t.do(ctx, proxy.Request{
		Target: "controller",
		Method: http.MethodPost,
		Path:   "rci/",
		Body:   body,
	})
	if err != nil {
		return rci.Response{}, err
	}

	return rci.Response{Status: response.Status, Body: response.Body}, nil
}
