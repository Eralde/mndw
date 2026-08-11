package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"mndw.local/httpsocket"
	"mws-page/internal/service"
)

type Server struct {
	service *service.Service
	socket  string
}

func New(serviceValue *service.Service) (*Server, error) {
	if serviceValue == nil {
		return nil, fmt.Errorf("service is required")
	}

	socket := os.Getenv("MNDW_BACKEND_SOCKET")

	if socket == "" {
		return nil, fmt.Errorf("MNDW_BACKEND_SOCKET is required")
	}

	return &Server{service: serviceValue, socket: socket}, nil
}

func (server *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", server.ready)
	mux.HandleFunc("GET /_mndw/diagnostics", server.diagnostics)
	mux.HandleFunc("POST /credentials", server.credentials)
	mux.HandleFunc("POST /forget", server.forget)
	mux.HandleFunc("GET /nodes", server.nodes)
	mux.HandleFunc("GET /snapshot", server.snapshot)
	mux.HandleFunc("POST /write", server.write)

	if err := httpsocket.Serve(ctx, server.socket, mux); err != nil {
		return err
	}

	return nil
}

func (server *Server) ready(writer http.ResponseWriter, _ *http.Request) {
	protocol, _ := strconv.Atoi(os.Getenv("MNDW_BACKEND_PROTOCOL"))

	if protocol == 0 {
		protocol = 1
	}

	writeJSON(writer, http.StatusOK, map[string]any{"pluginId": os.Getenv("MNDW_PLUGIN_ID"), "protocolVersion": protocol})
}

func (server *Server) credentials(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	if !decodeBody(writer, request, &input) {
		return
	}

	data, err := server.service.Credentials(request.Context(), input.Username, input.Password)

	server.writeResult(writer, data, err)
}

func (server *Server) forget(writer http.ResponseWriter, request *http.Request) {
	data, err := server.service.Forget(request.Context())

	server.writeResult(writer, data, err)
}

func (server *Server) nodes(writer http.ResponseWriter, request *http.Request) {
	data, err := server.service.Nodes(request.Context())

	server.writeResult(writer, data, err)
}

func (server *Server) snapshot(writer http.ResponseWriter, request *http.Request) {
	data, err := server.service.Snapshot(request.Context(), request.URL.Query().Get("nodeId"))

	server.writeResult(writer, data, err)
}

func (server *Server) write(writer http.ResponseWriter, request *http.Request) {
	var input service.WriteRequest

	if !decodeBody(writer, request, &input) {
		return
	}

	data, err := server.service.Write(request.Context(), input)

	server.writeResult(writer, data, err)
}

func (server *Server) diagnostics(writer http.ResponseWriter, _ *http.Request) {
	snapshot := server.service.DiagnosticsSnapshot()

	delete(snapshot, "runtime")
	writeJSON(writer, http.StatusOK, snapshot)
}

func (server *Server) writeResult(writer http.ResponseWriter, data any, err error) {
	if err == nil {
		writeJSON(writer, http.StatusOK, data)

		return
	}

	status := http.StatusBadGateway
	code := "BACKEND_FAILED"
	message := "backend operation failed"
	var operationErr interface {
		Status() int
		Code() string
	}

	if errors.As(err, &operationErr) {
		status = operationErr.Status()
		code = operationErr.Code()
		message = err.Error()
	}

	writeJSON(writer, status, map[string]any{"error": code, "message": message})
}

func decodeBody(writer http.ResponseWriter, request *http.Request, destination any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 128<<10)
	decoder := json.NewDecoder(io.LimitReader(request.Body, (128<<10)+1))

	if err := decoder.Decode(destination); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid JSON body"})

		return false
	}

	return true
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)

	_ = json.NewEncoder(writer).Encode(value)
}
