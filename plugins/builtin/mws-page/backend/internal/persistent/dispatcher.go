package persistent

import (
	"context"
	"sync"
	"time"

	"mndw.local/rcisock"
)

type dispatcher struct {
	mu        *sync.Mutex
	rpc       *rcisock.Client
	inflight  chan struct{}
	store     *targetStore
	ioTimeout time.Duration
}

func newDispatcher(mu *sync.Mutex, maxInflight int, store *targetStore, ioTimeout time.Duration) *dispatcher {
	return &dispatcher{
		mu:        mu,
		inflight:  make(chan struct{}, maxInflight),
		store:     store,
		ioTimeout: ioTimeout,
	}
}

func (p *dispatcher) send(ctx context.Context, nodeID string, request Request) (Response, error) {
	p.mu.Lock()

	rpc := p.rpc
	present := p.store.hasLocked(nodeID)
	targetLock := p.store.lockForLocked(nodeID)

	p.mu.Unlock()

	if !present || rpc == nil || targetLock == nil {
		return Response{}, ErrNoSession
	}

	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), p.ioTimeout)

	defer cancel()

	return p.callRPC(callContext, rpc, nodeID, targetLock, request)
}

func (p *dispatcher) call(ctx context.Context, rpc *rcisock.Client, nodeID string, request Request) (Response, error) {
	targetLock := p.store.lockFor(nodeID)

	if targetLock == nil {
		return Response{}, ErrNoSession
	}

	return p.callRPC(ctx, rpc, nodeID, targetLock, request)
}

func (p *dispatcher) callRPC(ctx context.Context, rpc *rcisock.Client, nodeID string, targetLock chan struct{}, request Request) (Response, error) {
	if err := acquire(ctx, p.inflight); err != nil {
		return Response{}, err
	}

	defer release(p.inflight)

	if err := acquireTarget(ctx, targetLock); err != nil {
		return Response{}, err
	}

	defer releaseTarget(targetLock)

	frame, err := rpc.Call(ctx, rcisock.RequestFrame{
		Target: nodeID, Method: request.Method, Path: request.Path, Body: request.Body,
	})
	if err != nil {
		return Response{}, err
	}

	return Response{Status: frame.Status, Body: append([]byte(nil), frame.Body...)}, nil
}

func (p *dispatcher) setRPC(rpc *rcisock.Client) {
	p.mu.Lock()

	p.rpc = rpc

	p.mu.Unlock()
}

func (p *dispatcher) clearRPC(rpc *rcisock.Client) {
	p.mu.Lock()

	if p.rpc == rpc {
		p.rpc = nil
	}

	p.mu.Unlock()
}

func acquire(ctx context.Context, semaphore chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case semaphore <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func release(semaphore chan struct{}) {
	<-semaphore
}

func acquireTarget(ctx context.Context, lock chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case <-lock:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func releaseTarget(lock chan struct{}) {
	lock <- struct{}{}
}

type rpcRequester struct {
	dispatch *dispatcher
	rpc      *rcisock.Client
	target   string
}

func (r rpcRequester) Do(ctx context.Context, request Request) (Response, error) {
	if r.dispatch != nil {
		return r.dispatch.call(ctx, r.rpc, r.target, request)
	}

	frame, err := r.rpc.Call(ctx, rcisock.RequestFrame{Target: r.target, Method: request.Method, Path: request.Path, Body: request.Body})
	if err != nil {
		return Response{}, err
	}

	return Response{Status: frame.Status, Body: append([]byte(nil), frame.Body...)}, nil
}
