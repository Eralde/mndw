package rcisock

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultIOTimeout     = 5 * time.Second
	defaultMaxFrameBytes = 8 << 20
)

type ClientOption func(*Client)

func WithIOTimeout(timeout time.Duration) ClientOption {
	return func(client *Client) {
		client.ioTimeout = timeout
	}
}

func WithHandshakeTimeout(timeout time.Duration) ClientOption {
	return func(client *Client) {
		client.handshakeTimeout = timeout
	}
}

func WithMaxFrameBytes(maxFrameBytes int) ClientOption {
	return func(client *Client) {
		client.maxFrameBytes = maxFrameBytes
	}
}

type Client struct {
	conn              net.Conn
	ioTimeout         time.Duration
	handshakeTimeout  time.Duration
	maxFrameBytes     int
	nextID            atomic.Int64
	writeSem          chan struct{}
	handshakeMu       sync.Mutex
	stateMu           sync.Mutex
	closed            bool
	handshakeStarted  bool
	handshakeComplete bool
	pending           map[int64]chan ResponseFrame
	done              chan struct{}
	closeOnce         sync.Once
	closeErr          error
	responseReader    *Reader[ResponseFrame]
}

func NewClient(conn net.Conn, options ...ClientOption) *Client {
	client := &Client{
		conn:           conn,
		writeSem:       make(chan struct{}, 1),
		pending:        make(map[int64]chan ResponseFrame),
		done:           make(chan struct{}),
		responseReader: NewReader[ResponseFrame](conn, defaultMaxFrameBytes),
	}

	for _, option := range options {
		if option != nil {
			option(client)
		}
	}

	if client.ioTimeout <= 0 {
		client.ioTimeout = defaultIOTimeout
	}

	if client.handshakeTimeout <= 0 {
		client.handshakeTimeout = client.ioTimeout
	}

	if client.maxFrameBytes <= 0 {
		client.maxFrameBytes = defaultMaxFrameBytes
	}

	client.responseReader = NewReader[ResponseFrame](conn, client.maxFrameBytes)

	return client
}

func (c *Client) Handshake(ctx context.Context, hello ClientHello) error {
	if ctx == nil {
		ctx = context.Background()
	}

	c.handshakeMu.Lock()

	defer c.handshakeMu.Unlock()

	c.stateMu.Lock()

	if c.closed {
		c.stateMu.Unlock()

		return ErrClosed
	}

	if c.handshakeStarted {
		c.stateMu.Unlock()

		return errHandshakeAlreadyAttempted
	}

	c.handshakeStarted = true

	c.stateMu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}

	if err := c.conn.SetDeadline(time.Now().Add(c.handshakeTimeout)); err != nil {
		return err
	}

	stop, watcherDone := startDeadlineWatcher(ctx, func() {
		_ = c.conn.SetDeadline(time.Now())
	})

	writeErr := WriteFrame(c.conn, RequestFrame{Hello: &hello})
	var response ResponseFrame
	var readErr error

	if writeErr == nil {
		response, readErr = c.responseReader.Next()
	}

	close(stop)
	<-watcherDone

	clearErr := c.conn.SetDeadline(time.Time{})

	if err := ctx.Err(); err != nil {
		return err
	}

	if writeErr != nil {
		return writeErr
	}

	if readErr != nil {
		return readErr
	}

	if clearErr != nil {
		return clearErr
	}

	if response.Hello == nil || response.Hello.Proto != ProtocolVersion || !response.Hello.OK {
		return errHandshakeRejected
	}

	c.stateMu.Lock()

	defer c.stateMu.Unlock()

	if c.closed {
		return ErrClosed
	}

	c.handshakeComplete = true

	go c.readLoop()

	return nil
}

func (c *Client) Call(ctx context.Context, frame RequestFrame) (ResponseFrame, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	requestContext, cancel := context.WithTimeout(ctx, c.ioTimeout)

	defer cancel()

	select {
	case c.writeSem <- struct{}{}:
	case <-requestContext.Done():
		return ResponseFrame{}, requestContext.Err()
	case <-c.done:
		return ResponseFrame{}, ErrClosed
	}

	defer func() { <-c.writeSem }()

	id := c.nextID.Add(1)

	if id <= 0 {
		c.nextID.Store(1)

		id = 1
	}

	frame.ID = id
	response := make(chan ResponseFrame, 1)

	c.stateMu.Lock()

	if c.closed {
		c.stateMu.Unlock()

		return ResponseFrame{}, ErrClosed
	}

	if !c.handshakeComplete {
		c.stateMu.Unlock()

		return ResponseFrame{}, errNotHandshaken
	}

	if err := requestContext.Err(); err != nil {
		c.stateMu.Unlock()

		return ResponseFrame{}, err
	}

	c.pending[id] = response

	c.stateMu.Unlock()

	writeErr := c.conn.SetWriteDeadline(time.Now().Add(c.ioTimeout))
	var clearErr error

	if writeErr == nil {
		stop, watcherDone := startDeadlineWatcher(ctx, func() {
			_ = c.conn.SetWriteDeadline(time.Now())
		})
		writeErr = WriteFrame(c.conn, frame)

		close(stop)
		<-watcherDone

		clearErr = c.conn.SetWriteDeadline(time.Time{})
	}

	if writeErr == nil && clearErr != nil {
		writeErr = clearErr
	}

	if writeErr != nil {
		c.removePending(id)

		_ = c.Close()

		if err := ctx.Err(); err != nil {
			return ResponseFrame{}, err
		}

		return ResponseFrame{}, fmt.Errorf("%w: %v", ErrClosed, writeErr)
	}

	select {
	case frame := <-response:
		if frame.Error != nil {
			return frame, &RemoteError{Code: frame.Error.Code}
		}

		return frame, nil
	case <-requestContext.Done():
		c.removePending(id)

		_ = c.Close()

		if err := ctx.Err(); err != nil {
			return ResponseFrame{}, err
		}

		return ResponseFrame{}, context.DeadlineExceeded
	case <-c.done:
		c.removePending(id)

		return ResponseFrame{}, ErrClosed
	}
}

func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		c.stateMu.Lock()

		if !c.closed {
			c.closed = true

			close(c.done)
		}

		c.stateMu.Unlock()

		c.closeErr = c.conn.Close()
	})

	return c.closeErr
}

func (c *Client) readLoop() {
	for {
		frame, err := c.responseReader.Next()
		if err != nil {
			_ = c.Close()

			return
		}

		if frame.ID == nil {
			continue
		}

		c.stateMu.Lock()

		response, ok := c.pending[*frame.ID]

		if ok {
			delete(c.pending, *frame.ID)
		}

		c.stateMu.Unlock()

		if ok {
			response <- frame
		}
	}
}

func (c *Client) removePending(id int64) {
	c.stateMu.Lock()
	delete(c.pending, id)
	c.stateMu.Unlock()
}

func startDeadlineWatcher(ctx context.Context, setImmediate func()) (chan struct{}, chan struct{}) {
	stop := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)

		select {
		case <-ctx.Done():
			setImmediate()
		case <-stop:
		}
	}()

	return stop, done
}
