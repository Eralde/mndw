package socket

import (
	"encoding/json"
	"fmt"
)

const (
	CommandCredentials = "credentials"
	CommandForget      = "forget"
	CommandNodes       = "nodes"
	CommandSnapshot    = "snapshot"
)

type Request struct {
	Command  string `json:"command"`
	Op       string `json:"op,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	NodeID   string `json:"nodeId,omitempty"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status"`
	Data   any    `json:"data,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

func DecodeRequest(data []byte) (Request, error) {
	var request Request
	if err := json.Unmarshal(data, &request); err != nil {
		return Request{}, fmt.Errorf("invalid request")
	}
	if request.Command == "" {
		request.Command = request.Op
	}
	if request.Op != "" && request.Command != request.Op {
		return Request{}, fmt.Errorf("conflicting command")
	}
	switch request.Command {
	case CommandCredentials, CommandForget, CommandNodes, CommandSnapshot:
		return request, nil
	default:
		return Request{}, fmt.Errorf("unknown command")
	}
}

func EncodeResponse(response Response) ([]byte, error) {
	return json.Marshal(response)
}

func Success(data any) Response { return Response{OK: true, Status: 200, Data: data} }
func Failure(status int, code, message string) Response {
	return Response{OK: false, Status: status, Error: &Error{Code: code, Message: message}}
}
