package socket

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestServerCreatesAndRemovesSocket(t *testing.T) {
	path := shortSocketPath(t)
	server := NewServer(path, Config{PluginID: "mws-page", Allowed: true}, &fakeHandler{})
	if err := server.Start(context.Background()); err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket stat = %v, info = %#v", err, info)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket path after close error = %v", err)
	}
}

func TestServerRefusesLiveListener(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}
	defer listener.Close()
	server := NewServer(path, Config{PluginID: "mws-page", Allowed: true}, &fakeHandler{})
	if err := server.Start(context.Background()); err == nil {
		t.Fatal("Start stole live Unix listener")
	}
}

func TestServerRecoversRefusedStaleSocket(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}
	listener.Close()
	server := NewServer(path, Config{PluginID: "mws-page", Allowed: true}, &fakeHandler{})
	if err := server.Start(context.Background()); err != nil {
		skipSocketEnvironment(t, err)
		t.Fatal(err)
	}
	defer server.Close()
	if _, err := net.DialTimeout("unix", path, time.Second); err != nil {
		t.Fatalf("dial recovered socket: %v", err)
	}
}

func TestServerClosesConnectionAcceptedDuringShutdown(t *testing.T) {
	path := shortSocketPath(t)
	listener := newLateAcceptListener()
	server := NewServer(path, Config{PluginID: "mws-page", Allowed: true}, &fakeHandler{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.mu.Lock()
	server.listener = listener
	server.cancel = cancel
	server.mu.Unlock()
	server.wait.Add(1)
	go server.acceptLoop(ctx, listener)
	<-listener.acceptStarted

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- server.Close()
	}()
	<-listener.closed

	client, peer := net.Pipe()
	accepted := &closeTrackingConn{Conn: peer}
	defer client.Close()
	defer accepted.Close()
	listener.next <- accepted

	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Server.Close() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Server.Close() remained blocked on a connection accepted during shutdown")
	}

	if !accepted.closed.Load() {
		t.Fatal("late-accepted connection remained open after Server.Close()")
	}
}

type closeTrackingConn struct {
	net.Conn
	closed atomic.Bool
}

func (c *closeTrackingConn) Close() error {
	c.closed.Store(true)
	return c.Conn.Close()
}

type lateAcceptListener struct {
	next            chan net.Conn
	acceptStarted   chan struct{}
	closed          chan struct{}
	acceptStartOnce sync.Once
	closeOnce       sync.Once
	closedState     atomic.Bool
}

func newLateAcceptListener() *lateAcceptListener {
	return &lateAcceptListener{
		next:          make(chan net.Conn, 1),
		acceptStarted: make(chan struct{}),
		closed:        make(chan struct{}),
	}
}

func (l *lateAcceptListener) Accept() (net.Conn, error) {
	l.acceptStartOnce.Do(func() { close(l.acceptStarted) })
	if l.closedState.Load() {
		return nil, net.ErrClosed
	}
	select {
	case connection := <-l.next:
		return connection, nil
	case <-l.closed:
		return <-l.next, nil
	}
}

func (l *lateAcceptListener) Close() error {
	l.closeOnce.Do(func() {
		l.closedState.Store(true)
		close(l.closed)
	})
	return nil
}

func (l *lateAcceptListener) Addr() net.Addr { return lateAcceptAddr("test") }

type lateAcceptAddr string

func (a lateAcceptAddr) Network() string { return string(a) }

func (a lateAcceptAddr) String() string { return string(a) }

func shortSocketPath(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "s")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return filepath.Join(root, "s.sock")
}

func skipSocketEnvironment(t *testing.T, err error) {
	t.Helper()
	if strings.Contains(err.Error(), "operation not permitted") || strings.Contains(err.Error(), "invalid argument") {
		t.Skipf("Unix listener unavailable in test environment: %v", err)
	}
}
