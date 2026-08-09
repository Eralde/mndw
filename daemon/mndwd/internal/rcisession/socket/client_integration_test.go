package socket

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"

	"mndw.local/rcisock"
	"mndwd/internal/rcisession/proxy"
)

func TestSharedClientAndServerInteroperate(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()

	defer clientConnection.Close()

	defer serverConnection.Close()

	handler := &integrationHandler{
		targets:  []rcisock.Target{{Identity: "node-1", Name: "Node 1", MAC: "aa:bb:cc:dd:ee:ff"}},
		response: proxy.Response{Status: 200, Body: []byte(`{"ok":true}`)},
	}
	serverDone := make(chan error, 1)

	go func() {
		serverDone <- ServeConnection(context.Background(), serverConnection, Config{
			PluginID: "mws-page",
			Allowed:  true,
		}, handler)
	}()

	client := rcisock.NewClient(clientConnection)

	if err := client.Handshake(context.Background(), rcisock.ClientHello{PluginID: "mws-page", Proto: rcisock.ProtocolVersion}); err != nil {
		t.Fatal(err)
	}

	targetsResponse, err := client.Call(context.Background(), rcisock.RequestFrame{Op: "targets"})
	if err != nil {
		t.Fatal(err)
	}

	if len(targetsResponse.Targets) != 1 || targetsResponse.Targets[0].Identity != "node-1" {
		t.Fatalf("targets response = %+v", targetsResponse.Targets)
	}

	response, err := client.Call(context.Background(), rcisock.RequestFrame{
		Target: "node-1",
		Method: "GET",
		Path:   "rci/show/version",
	})
	if err != nil {
		t.Fatal(err)
	}

	if response.Status != 200 || string(response.Body) != `{"ok":true}` {
		t.Fatalf("response = %+v", response)
	}

	handler.requestError = proxy.ErrNoSession
	_, err = client.Call(context.Background(), rcisock.RequestFrame{Target: "node-1", Method: "GET", Path: "rci/show/version"})
	var remoteError *rcisock.RemoteError

	if !errors.As(err, &remoteError) || remoteError.Code != "no-session-for-target" {
		t.Fatalf("error = %v, want no-session-for-target RemoteError", err)
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	if err := <-serverDone; err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
		t.Fatalf("ServeConnection error = %v", err)
	}
}

func TestDirectionTypedRequestRejectsResponseKeys(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()

	defer clientConnection.Close()

	defer serverConnection.Close()

	serverDone := make(chan error, 1)

	go func() {
		serverDone <- ServeConnection(context.Background(), serverConnection, Config{
			PluginID: "mws-page",
			Allowed:  true,
		}, &integrationHandler{})
	}()

	if err := rcisock.WriteFrame(clientConnection, rcisock.RequestFrame{Hello: &rcisock.ClientHello{PluginID: "mws-page", Proto: rcisock.ProtocolVersion}}); err != nil {
		t.Fatal(err)
	}

	reader := rcisock.NewReader[rcisock.ResponseFrame](clientConnection, 8<<20)

	if _, err := reader.Next(); err != nil {
		t.Fatal(err)
	}

	_, err := clientConnection.Write([]byte(`{"id":1,"status":0}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}

	if err := <-serverDone; !errors.Is(err, proxy.ErrBadRequest) {
		t.Fatalf("ServeConnection error = %v, want proxy.ErrBadRequest", err)
	}
}

type integrationHandler struct {
	targets      []rcisock.Target
	response     proxy.Response
	requestError error
}

func (h *integrationHandler) Do(context.Context, proxy.Request) (proxy.Response, error) {
	if h.requestError != nil {
		return proxy.Response{}, h.requestError
	}

	return h.response, nil
}

func (h *integrationHandler) Targets(context.Context) ([]rcisock.Target, error) {
	return h.targets, nil
}
