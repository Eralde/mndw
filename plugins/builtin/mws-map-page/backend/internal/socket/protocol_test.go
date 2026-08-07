package socket

import (
	"context"
	"testing"
)

type semanticService struct{}

func (semanticService) Credentials(context.Context, string, string) (any, error) { return nil, nil }
func (semanticService) Forget(context.Context) (any, error)                      { return nil, nil }
func (semanticService) Nodes(context.Context) (any, error) {
	return nil, semanticError{}
}
func (semanticService) Snapshot(context.Context, string) (any, error) { return nil, nil }

type semanticError struct{}

func (semanticError) Error() string { return "credentials required" }
func (semanticError) Status() int   { return 409 }
func (semanticError) Code() string  { return "credentials_required" }

func TestProtocolCommandsAndSemanticStatus(t *testing.T) {
	for _, command := range []string{CommandCredentials, CommandForget, CommandNodes, CommandSnapshot} {
		request, err := DecodeRequest([]byte(`{"command":"` + command + `"}`))
		if err != nil || request.Command != command {
			t.Fatalf("command %q decoded as %#v, %v", command, request, err)
		}
	}
	response := Failure(401, "CREDENTIALS_REQUIRED", "credentials required")
	data, err := EncodeResponse(response)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || response.Status != 401 || response.OK {
		t.Fatalf("response = %#v", response)
	}
}

func TestDecodeRequestAcceptsSpecOperationField(t *testing.T) {
	request, err := DecodeRequest([]byte(`{"op":"snapshot","nodeId":"node-1"}`))
	if err != nil || request.Command != CommandSnapshot || request.NodeID != "node-1" {
		t.Fatalf("request = %#v, error = %v", request, err)
	}
}

func TestServerPreservesSemanticStatus(t *testing.T) {
	server := &Server{Service: semanticService{}}
	response := server.dispatch(context.Background(), Request{Command: CommandNodes})
	if response.OK || response.Status != 409 || response.Error == nil || response.Error.Code != "credentials_required" {
		t.Fatalf("response = %#v", response)
	}
}
