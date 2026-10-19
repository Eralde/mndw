package rcisock

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOptionNormalizationUsesResolvedIOTimeout(t *testing.T) {
	client := NewClient(&recordingConn{}, WithIOTimeout(30*time.Second))

	if client.ioTimeout != 30*time.Second || client.handshakeTimeout != 30*time.Second {
		t.Fatalf("timeouts = %s/%s, want 30s/30s", client.ioTimeout, client.handshakeTimeout)
	}

	if client.maxFrameBytes != 8<<20 {
		t.Fatalf("maxFrameBytes = %d, want %d", client.maxFrameBytes, 8<<20)
	}
}

func TestCloseIsIdempotentAndReturnsFirstCloseError(t *testing.T) {
	closeErr := errors.New("close failed")
	connection := &recordingConn{closeErr: closeErr}
	client := NewClient(connection)

	if err := client.Close(); !errors.Is(err, closeErr) {
		t.Fatalf("first Close error = %v, want %v", err, closeErr)
	}

	if err := client.Close(); !errors.Is(err, closeErr) {
		t.Fatalf("second Close error = %v, want %v", err, closeErr)
	}

	if connection.closeCalls.Load() != 1 {
		t.Fatalf("connection close calls = %d, want 1", connection.closeCalls.Load())
	}
}

func TestCallBeforeHandshakeReturnsError(t *testing.T) {
	connection := &recordingConn{}
	client := NewClient(connection)

	if _, err := client.Call(context.Background(), RequestFrame{Op: "targets"}); !errors.Is(err, errNotHandshaken) {
		t.Fatalf("Call error = %v, want errNotHandshaken", err)
	}

	if connection.writeCalls.Load() != 0 {
		t.Fatalf("writes = %d, want 0", connection.writeCalls.Load())
	}
}

func TestHandshakeConsumesIDLessHelloBeforeReadLoop(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	serverDone := make(chan error, 1)

	go func() {
		reader := NewReader[RequestFrame](server, 64*1024)

		if _, err := reader.Next(); err != nil {
			serverDone <- err

			return
		}

		serverDone <- WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})
	}()

	client := NewClient(clientConnection, WithHandshakeTimeout(time.Second))

	if err := client.Handshake(context.Background(), ClientHello{PluginID: "plugin", Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHandshakeRejectsProtocolMismatch(t *testing.T) {
	err := runHandshakeResponse(t, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion + 1, OK: true}})
	if err == nil {
		t.Fatal("protocol mismatch was accepted")
	}
}

func TestHandshakeRejectsMissingOK(t *testing.T) {
	err := runHandshakeResponse(t, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion}})
	if err == nil {
		t.Fatal("hello without OK was accepted")
	}
}

func TestHandshakeDeadlineAbortsStalledPeer(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	client := NewClient(clientConnection, WithHandshakeTimeout(20*time.Millisecond))

	started := time.Now()
	err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion})
	if err == nil {
		t.Fatal("stalled handshake succeeded")
	}

	if time.Since(started) > time.Second {
		t.Fatalf("handshake took too long: %s", time.Since(started))
	}
}

func TestHandshakeCancellationReturnsContextError(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	client := NewClient(clientConnection, WithHandshakeTimeout(5*time.Second))
	ctx, cancel := context.WithCancel(context.Background())

	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	err := client.Handshake(ctx, ClientHello{Proto: ProtocolVersion})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("handshake error = %v, want context.Canceled", err)
	}
}

func TestConcurrentHandshakeRejected(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	serverReady := make(chan struct{})

	go func() {
		reader := NewReader[RequestFrame](server, 64*1024)
		_, _ = reader.Next()

		close(serverReady)
		<-time.After(time.Second)
	}()

	client := NewClient(clientConnection, WithHandshakeTimeout(time.Second))
	firstContext, cancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)

	go func() {
		firstDone <- client.Handshake(firstContext, ClientHello{Proto: ProtocolVersion})
	}()

	<-serverReady

	secondDone := make(chan error, 1)

	go func() {
		secondDone <- client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion})
	}()

	cancel()

	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("first handshake error = %v, want context.Canceled", err)
	}

	if err := <-secondDone; !errors.Is(err, errHandshakeAlreadyAttempted) {
		t.Fatalf("second handshake error = %v, want errHandshakeAlreadyAttempted", err)
	}
}

func TestConcurrentCallsCorrelateResponses(t *testing.T) {
	client, server := startEchoClient(t, 500*time.Millisecond)

	defer client.Close()

	defer server.Close()

	const callCount = 16
	results := make(chan error, callCount)

	for index := 0; index < callCount; index++ {
		index := index

		go func() {
			response, err := client.Call(context.Background(), RequestFrame{Op: "request", Body: []byte(fmt.Sprintf("%d", index))})
			if err != nil {
				results <- err

				return
			}

			if string(response.Body) != fmt.Sprintf("%d", index) {
				results <- fmt.Errorf("response body = %s, want %d", response.Body, index)

				return
			}

			results <- nil
		}()
	}

	for index := 0; index < callCount; index++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestCanceledWaiterDoesNotWriteOrCloseHealthyConnection(t *testing.T) {
	connection := newBlockingWriteConn(errors.New("write interrupted"))
	client := NewClient(connection, WithIOTimeout(time.Second))

	markClientHandshaken(client)

	firstDone := make(chan error, 1)

	go func() {
		_, err := client.Call(context.Background(), RequestFrame{Op: "first"})
		firstDone <- err
	}()

	<-connection.writeStarted

	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	if _, err := client.Call(ctx, RequestFrame{Op: "second"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter error = %v, want context.Canceled", err)
	}

	if connection.writeCalls.Load() != 1 {
		t.Fatalf("writes = %d, want 1", connection.writeCalls.Load())
	}

	if connection.closeCalls.Load() != 0 {
		t.Fatalf("close calls = %d, want 0", connection.closeCalls.Load())
	}

	_ = client.Close()

	if err := <-firstDone; !errors.Is(err, ErrClosed) {
		t.Fatalf("first call error = %v, want ErrClosed", err)
	}
}

func TestConcurrentCancellationDoesNotPoisonReadLoop(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	client := NewClient(clientConnection, WithIOTimeout(time.Second))
	reader := NewReader[RequestFrame](server, 64*1024)
	helloDone := make(chan error, 1)

	go func() {
		if _, err := reader.Next(); err != nil {
			helloDone <- err

			return
		}

		helloDone <- WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})
	}()

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	if err := <-helloDone; err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan error, 1)

	go func() {
		_, err := client.Call(context.Background(), RequestFrame{Op: "first"})
		firstDone <- err
	}()

	secondContext, cancel := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)

	go func() {
		_, err := client.Call(secondContext, RequestFrame{Op: "second"})
		secondDone <- err
	}()

	cancel()

	if err := <-secondDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled call error = %v, want context.Canceled", err)
	}

	first, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}

	firstID := first.ID

	if err := WriteFrame(server, ResponseFrame{ID: &firstID, Body: []byte(`{"ok":true}`)}); err != nil {
		t.Fatal(err)
	}

	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}

	thirdDone := make(chan error, 1)

	go func() {
		_, err := client.Call(context.Background(), RequestFrame{Op: "third"})
		thirdDone <- err
	}()

	third, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}

	thirdID := third.ID

	if err := WriteFrame(server, ResponseFrame{ID: &thirdID, Body: []byte(`{"ok":true}`)}); err != nil {
		t.Fatal(err)
	}

	if err := <-thirdDone; err != nil {
		t.Fatal(err)
	}

	client.Close()
}

func TestPendingDeliveryRaceDoesNotBlockReadLoop(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	client := NewClient(clientConnection, WithIOTimeout(time.Second))
	reader := NewReader[RequestFrame](server, 64*1024)
	helloDone := make(chan error, 1)

	go func() {
		if _, err := reader.Next(); err != nil {
			helloDone <- err

			return
		}

		helloDone <- WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})
	}()

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	if err := <-helloDone; err != nil {
		t.Fatal(err)
	}

	requestSeen := make(chan struct{})

	go func() {
		request, err := reader.Next()
		if err != nil {
			return
		}

		close(requestSeen)
		<-time.After(20 * time.Millisecond)

		id := request.ID
		_ = WriteFrame(server, ResponseFrame{ID: &id, Body: []byte(`{"ok":true}`)})
	}()

	ctx, cancel := context.WithCancel(context.Background())
	callDone := make(chan error, 1)

	go func() {
		_, err := client.Call(ctx, RequestFrame{Op: "race"})
		callDone <- err
	}()

	<-requestSeen
	cancel()

	select {
	case <-callDone:
	case <-time.After(time.Second):
		t.Fatal("canceled call did not return")
	}

	client.Close()
}

func TestCloseWinsStateLinearizationBeforePendingRegistration(t *testing.T) {
	connection := &recordingConn{}
	client := NewClient(connection)

	markClientHandshaken(client)
	client.stateMu.Lock()

	client.closed = true

	close(client.done)

	callDone := make(chan error, 1)

	go func() {
		_, err := client.Call(context.Background(), RequestFrame{Op: "race"})
		callDone <- err
	}()

	client.stateMu.Unlock()

	if err := <-callDone; !errors.Is(err, ErrClosed) {
		t.Fatalf("call error = %v, want ErrClosed", err)
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	client.stateMu.Lock()

	pendingCount := len(client.pending)

	client.stateMu.Unlock()

	if pendingCount != 0 || connection.writeCalls.Load() != 0 {
		t.Fatalf("pending=%d writes=%d, want 0/0", pendingCount, connection.writeCalls.Load())
	}
}

func TestRemoteEOFClosesClientAndWakesCall(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	client := NewClient(clientConnection, WithIOTimeout(time.Second))
	reader := NewReader[RequestFrame](server, 64*1024)
	helloDone := make(chan error, 1)

	go func() {
		if _, err := reader.Next(); err != nil {
			helloDone <- err

			return
		}

		helloDone <- WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})
	}()

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	if err := <-helloDone; err != nil {
		t.Fatal(err)
	}

	requestDone := make(chan struct{})

	go func() {
		_, _ = reader.Next()

		close(requestDone)
		server.Close()
	}()

	callDone := make(chan error, 1)

	go func() {
		_, err := client.Call(context.Background(), RequestFrame{Op: "eof"})
		callDone <- err
	}()

	<-requestDone

	select {
	case err := <-callDone:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("call error = %v, want ErrClosed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("call did not wake after remote EOF")
	}
}

func TestPerCallTimeoutClosesConnection(t *testing.T) {
	client, server := startHandshakeOnlyClient(t, 20*time.Millisecond)

	defer server.Close()

	defer client.Close()

	_, err := client.Call(context.Background(), RequestFrame{Op: "timeout"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("call error = %v, want context.DeadlineExceeded", err)
	}

	if !client.isClosed() {
		t.Fatal("client remained open after per-call timeout")
	}
}

func TestBlockedWriteCancellationReturnsContextError(t *testing.T) {
	connection := newBlockingWriteConn(errors.New("write interrupted"))
	client := NewClient(connection, WithIOTimeout(time.Second))

	markClientHandshaken(client)

	ctx, cancel := context.WithCancel(context.Background())
	callDone := make(chan error, 1)

	go func() {
		_, err := client.Call(ctx, RequestFrame{Op: "cancel"})
		callDone <- err
	}()

	<-connection.writeStarted
	cancel()

	if err := <-callDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("call error = %v, want context.Canceled", err)
	}

	if connection.closeCalls.Load() == 0 {
		t.Fatal("active write cancellation did not close client")
	}
}

func TestBlockedWriteDeadlineReturnsClosed(t *testing.T) {
	connection := newBlockingWriteConn(timeoutWriteError{})
	client := NewClient(connection, WithIOTimeout(20*time.Millisecond))

	markClientHandshaken(client)

	_, err := client.Call(context.Background(), RequestFrame{Op: "deadline"})
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("call error = %v, want ErrClosed", err)
	}

	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("call error = %v, must not be context.DeadlineExceeded", err)
	}
}

func TestRemoteErrorMapsToRemoteError(t *testing.T) {
	server, clientConnection := net.Pipe()

	defer server.Close()

	client := NewClient(clientConnection, WithIOTimeout(time.Second))

	go func() {
		reader := NewReader[RequestFrame](server, 64*1024)
		_, _ = reader.Next()
		_ = WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}})
		request, err := reader.Next()
		if err != nil {
			return
		}

		id := request.ID
		_ = WriteFrame(server, ResponseFrame{ID: &id, Error: &Error{Code: "no-session-for-target", Message: "no-session-for-target"}})
	}()

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	_, err := client.Call(context.Background(), RequestFrame{Op: "error"})
	var remote *RemoteError

	if !errors.As(err, &remote) || remote.Code != "no-session-for-target" {
		t.Fatalf("call error = %v, want RemoteError", err)
	}
}

func markClientHandshaken(client *Client) {
	client.stateMu.Lock()

	client.handshakeStarted = true
	client.handshakeComplete = true

	client.stateMu.Unlock()
}

func runHandshakeResponse(t *testing.T, response ResponseFrame) error {
	t.Helper()

	server, clientConnection := net.Pipe()

	defer server.Close()

	defer clientConnection.Close()

	go func() {
		reader := NewReader[RequestFrame](server, 64*1024)

		if _, err := reader.Next(); err != nil {
			return
		}

		_ = WriteFrame(server, response)
	}()

	client := NewClient(clientConnection, WithHandshakeTimeout(time.Second))

	defer client.Close()

	return client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion})
}

func startEchoClient(t *testing.T, ioTimeout time.Duration) (*Client, net.Conn) {
	t.Helper()

	server, clientConnection := net.Pipe()

	go func() {
		defer server.Close()

		reader := NewReader[RequestFrame](server, 64*1024)

		if _, err := reader.Next(); err != nil {
			return
		}

		if err := WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}}); err != nil {
			return
		}

		for {
			request, err := reader.Next()
			if err != nil {
				return
			}

			id := request.ID
			body := request.Body

			if len(body) == 0 {
				body = []byte(fmt.Sprintf("%d", request.ID))
			}

			if err := WriteFrame(server, ResponseFrame{ID: &id, Body: body}); err != nil {
				return
			}
		}
	}()

	client := NewClient(clientConnection, WithIOTimeout(ioTimeout))

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	return client, server
}

func startHandshakeOnlyClient(t *testing.T, ioTimeout time.Duration) (*Client, net.Conn) {
	t.Helper()

	server, clientConnection := net.Pipe()

	go func() {
		defer server.Close()

		reader := NewReader[RequestFrame](server, 64*1024)

		if _, err := reader.Next(); err != nil {
			return
		}

		if err := WriteFrame(server, ResponseFrame{Hello: &ServerHello{Proto: ProtocolVersion, OK: true}}); err != nil {
			return
		}

		for {
			if _, err := reader.Next(); err != nil {
				return
			}
		}
	}()

	client := NewClient(clientConnection, WithIOTimeout(ioTimeout))

	if err := client.Handshake(context.Background(), ClientHello{Proto: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	return client, server
}

func (c *Client) isClosed() bool {
	c.stateMu.Lock()

	defer c.stateMu.Unlock()

	return c.closed
}

type recordingConn struct {
	closed     chan struct{}
	closeOnce  sync.Once
	closeErr   error
	closeCalls atomic.Int32
	writeCalls atomic.Int32
}

func (c *recordingConn) Read([]byte) (int, error) {
	if c.closed == nil {
		c.closed = make(chan struct{})
	}

	<-c.closed

	return 0, io.EOF
}

func (c *recordingConn) Write(data []byte) (int, error) {
	c.writeCalls.Add(1)

	return len(data), nil
}

func (c *recordingConn) Close() error {
	if c.closed == nil {
		c.closed = make(chan struct{})
	}

	c.closeCalls.Add(1)
	c.closeOnce.Do(func() { close(c.closed) })

	return c.closeErr
}

func (*recordingConn) LocalAddr() net.Addr              { return testAddr("local") }
func (*recordingConn) RemoteAddr() net.Addr             { return testAddr("remote") }
func (*recordingConn) SetDeadline(time.Time) error      { return nil }
func (*recordingConn) SetReadDeadline(time.Time) error  { return nil }
func (*recordingConn) SetWriteDeadline(time.Time) error { return nil }

type blockingWriteConn struct {
	closed          chan struct{}
	immediate       chan struct{}
	closeOnce       sync.Once
	immediateOnce   sync.Once
	writeStarted    chan struct{}
	writeStartedOne sync.Once
	writeErr        error
	writeCalls      atomic.Int32
	closeCalls      atomic.Int32
}

func newBlockingWriteConn(writeErr error) *blockingWriteConn {
	return &blockingWriteConn{
		closed:       make(chan struct{}),
		immediate:    make(chan struct{}),
		writeStarted: make(chan struct{}),
		writeErr:     writeErr,
	}
}

func (c *blockingWriteConn) Read([]byte) (int, error) {
	<-c.closed

	return 0, io.EOF
}

func (c *blockingWriteConn) Write([]byte) (int, error) {
	c.writeCalls.Add(1)
	c.writeStartedOne.Do(func() { close(c.writeStarted) })

	select {
	case <-c.immediate:
		return 0, c.writeErr
	case <-c.closed:
		return 0, c.writeErr
	}
}

func (c *blockingWriteConn) Close() error {
	c.closeCalls.Add(1)
	c.closeOnce.Do(func() { close(c.closed) })

	return nil
}

func (*blockingWriteConn) LocalAddr() net.Addr             { return testAddr("local") }
func (*blockingWriteConn) RemoteAddr() net.Addr            { return testAddr("remote") }
func (*blockingWriteConn) SetDeadline(time.Time) error     { return nil }
func (*blockingWriteConn) SetReadDeadline(time.Time) error { return nil }
func (c *blockingWriteConn) SetWriteDeadline(deadline time.Time) error {
	if deadline.IsZero() {
		return nil
	}

	if deadline.After(time.Now()) {
		duration := time.Until(deadline)

		go func() {
			timer := time.NewTimer(duration)

			defer timer.Stop()

			<-timer.C
			c.signalImmediate()
		}()

		return nil
	}

	c.signalImmediate()

	return nil
}

func (c *blockingWriteConn) signalImmediate() {
	c.immediateOnce.Do(func() { close(c.immediate) })
}

type timeoutWriteError struct{}

func (timeoutWriteError) Error() string   { return "write timeout" }
func (timeoutWriteError) Timeout() bool   { return true }
func (timeoutWriteError) Temporary() bool { return true }

type testAddr string

func (a testAddr) Network() string { return "test" }
func (a testAddr) String() string  { return string(a) }

var _ net.Conn = (*recordingConn)(nil)
var _ net.Conn = (*blockingWriteConn)(nil)
