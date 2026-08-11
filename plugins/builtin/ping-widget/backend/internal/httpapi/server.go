package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

	"mndw.local/httpsocket"
	"ping-widget/internal/model"
)

type Service interface {
	Stats() []model.HostStats
	Hosts() []model.Host
	UpdateHosts(model.HostUpdateInput) ([]model.Host, error)
	Running() bool
	SetRunning(bool)
	Persist() error
}

type Server struct {
	service Service
	socket  string
}

func New(service Service) (*Server, error) {
	socket := os.Getenv("MNDW_BACKEND_SOCKET")

	if socket == "" {
		return nil, fmt.Errorf("MNDW_BACKEND_SOCKET is required")
	}

	return &Server{service: service, socket: socket}, nil
}

func (server *Server) Run(ctx context.Context) error {
	if err := httpsocket.Serve(ctx, server.socket, newMux(server)); err != nil {
		return err
	}

	return server.service.Persist()
}

func newMux(server *Server) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", server.ready)
	mux.HandleFunc("GET /stats", server.stats)
	mux.HandleFunc("GET /hosts", server.hosts)
	mux.HandleFunc("POST /hosts", server.updateHosts)
	mux.HandleFunc("GET /control", server.control)
	mux.HandleFunc("POST /control", server.updateControl)

	return mux
}

func (server *Server) ready(writer http.ResponseWriter, _ *http.Request) {
	protocol, _ := strconv.Atoi(os.Getenv("MNDW_BACKEND_PROTOCOL"))

	if protocol == 0 {
		protocol = 1
	}

	writeJSON(writer, http.StatusOK, map[string]any{"pluginId": os.Getenv("MNDW_PLUGIN_ID"), "protocolVersion": protocol})
}

func (server *Server) stats(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, server.service.Stats())
}

func (server *Server) hosts(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, server.service.Hosts())
}

func (server *Server) control(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]bool{"running": server.service.Running()})
}

func (server *Server) updateControl(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 128<<10)
	var input struct {
		Action string `json:"action"`
	}

	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":   "BAD_REQUEST",
			"message": "invalid ping control request",
		})

		return
	}

	switch strings.ToLower(strings.TrimSpace(input.Action)) {
	case "start":
		server.service.SetRunning(true)
	case "stop":
		server.service.SetRunning(false)
	default:
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":   "INVALID_CONTROL_ACTION",
			"message": "action must be start or stop",
		})

		return
	}

	server.control(writer, request)
}

func (server *Server) updateHosts(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, 128<<10)
	var input model.HostUpdateInput

	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "BAD_REQUEST", "message": "invalid host update"})

		return
	}

	hosts, err := server.service.UpdateHosts(input)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "INVALID_HOST_UPDATE", "message": err.Error()})

		return
	}

	writeJSON(writer, http.StatusOK, hosts)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)

	_ = json.NewEncoder(writer).Encode(value)
}
