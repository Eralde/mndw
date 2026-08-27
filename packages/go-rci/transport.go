package rci

import "context"

type Response struct {
	Status int
	Body   []byte
}

type Transport interface {
	Send(context.Context, []byte) (Response, error)
}

type TransportFunc func(context.Context, []byte) (Response, error)

func (f TransportFunc) Send(ctx context.Context, body []byte) (Response, error) {
	return f(ctx, body)
}
