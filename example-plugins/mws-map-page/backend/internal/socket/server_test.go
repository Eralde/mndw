package socket

import (
	"bufio"
	"context"
	"net"
	"testing"
	"time"
)

type immediateService struct {
	nodesCalled chan struct{}
}

func (s *immediateService) Credentials(context.Context, string, string) (any, error) {
	return nil, nil
}

func (s *immediateService) Forget(context.Context) (any, error) { return nil, nil }

func (s *immediateService) Nodes(context.Context) (any, error) {
	close(s.nodesCalled)

	return map[string]any{"nodes": []any{}}, nil
}

func (s *immediateService) Snapshot(context.Context, string) (any, error) { return nil, nil }

func TestServeConnectionDispatchesWithoutWaitingForPeerClose(t *testing.T) {
	service := &immediateService{nodesCalled: make(chan struct{})}
	server := &Server{
		IOTimeout:     time.Hour,
		AuthTimeout:   time.Hour,
		RequestLimit:  defaultRequestLimit,
		ResponseLimit: defaultResponseLimit,
		Service:       service,
	}
	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()

	done := make(chan struct{})
	go func() {
		server.serveConnection(serverConn)
		close(done)
	}()

	if _, err := clientConn.Write([]byte(`{"command":"nodes"}` + "\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}

	select {
	case <-service.nodesCalled:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("server waited for peer close before dispatching request")
	}

	if err := clientConn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if _, err := bufio.NewReader(clientConn).ReadBytes('\n'); err != nil {
		t.Fatalf("read response: %v", err)
	}

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("server connection did not finish")
	}
}
