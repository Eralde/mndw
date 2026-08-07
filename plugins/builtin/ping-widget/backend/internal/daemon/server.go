package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ping-widget/internal/config"
	"ping-widget/internal/model"
	"ping-widget/internal/persistence"
	"ping-widget/internal/ping"
)

const (
	pingInterval    = 5 * time.Second
	persistInterval = 20 * time.Second
)

type Server struct {
	store    *persistence.JSONStore
	state    *ServiceState
	listener net.Listener

	stopOnce sync.Once
	stopChan chan struct{}
}

func NewServer() (*Server, error) {
	store := persistence.NewDefaultStore()
	hosts, hostsErr := store.LoadHosts()
	if hostsErr != nil {
		return nil, hostsErr
	}

	samplesByHost, samplesErr := store.LoadStatsState()
	if samplesErr != nil {
		return nil, samplesErr
	}

	return &Server{
		store:    store,
		state:    NewServiceState(hosts, samplesByHost),
		stopChan: make(chan struct{}),
	}, nil
}

func (server *Server) Run() error {
	if err := cleanupStaleSocket(); err != nil {
		return err
	}

	listener, err := net.Listen("unix", config.SocketPath())
	if err != nil {
		return err
	}

	server.listener = listener

	if err := os.WriteFile(config.PidFilePath(), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		_ = server.listener.Close()
		return err
	}

	defer server.cleanup()

	go server.runPingLoop()
	go server.runPersistLoop()

	for {
		connection, acceptErr := server.listener.Accept()
		if acceptErr != nil {
			if isStopped(server.stopChan) {
				return nil
			}
			if errors.Is(acceptErr, net.ErrClosed) {
				return nil
			}
			continue
		}

		go server.handleConnection(connection)
	}
}

func IsProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}

	err := syscall.Kill(pid, 0)
	return err == nil
}

func ReadRunningPid() (int, bool) {
	data, err := os.ReadFile(config.PidFilePath())
	if err != nil {
		return 0, false
	}

	pidValue, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if parseErr != nil {
		return 0, false
	}

	if IsProcessRunning(pidValue) {
		return pidValue, true
	}

	return 0, false
}

func (server *Server) handleConnection(connection net.Conn) {
	defer connection.Close()

	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))

	decoder := json.NewDecoder(connection)
	request := model.Request{}
	if err := decoder.Decode(&request); err != nil {
		_ = json.NewEncoder(connection).Encode(model.Response{
			Success: false,
			Error:   "INVALID_REQUEST",
			Message: "Could not decode request",
		})
		return
	}

	response := server.handleRequest(request)
	_ = json.NewEncoder(connection).Encode(response)
}

func (server *Server) handleRequest(request model.Request) model.Response {
	switch request.Cmd {
	case "stats":
		return model.Response{Success: true, Data: server.state.Stats()}
	case "hosts-list":
		return model.Response{Success: true, Data: server.state.ListHosts()}
	case "hosts-update":
		hosts, err := server.state.ApplyHostUpdate(request.Body)
		if err != nil {
			return model.Response{Success: false, Error: "INVALID_HOST_UPDATE", Message: err.Error()}
		}

		_ = server.persist()
		return model.Response{Success: true, Data: hosts}
	case "persist-now":
		if err := server.persist(); err != nil {
			return model.Response{Success: false, Error: "PERSIST_FAILED", Message: err.Error()}
		}
		return model.Response{Success: true, Message: "State persisted"}
	case "stop":
		if err := server.persist(); err != nil {
			return model.Response{Success: false, Error: "PERSIST_FAILED", Message: err.Error()}
		}

		go server.stop()
		return model.Response{Success: true, Message: "Stopping daemon"}
	default:
		return model.Response{Success: false, Error: "UNKNOWN_COMMAND", Message: "Unsupported command"}
	}
}

func (server *Server) runPingLoop() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	run := func() {
		hosts := server.state.PingTargets()
		for _, host := range hosts {
			sample := ping.RunOnce(host.IP, 4*time.Second)
			server.state.RecordSample(host.IP, sample)
		}
	}

	run()

	for {
		select {
		case <-server.stopChan:
			return
		case <-ticker.C:
			run()
		}
	}
}

func (server *Server) runPersistLoop() {
	ticker := time.NewTicker(persistInterval)
	defer ticker.Stop()

	for {
		select {
		case <-server.stopChan:
			return
		case <-ticker.C:
			_ = server.persist()
		}
	}
}

func (server *Server) persist() error {
	hosts := server.state.HostSnapshot()
	samples := server.state.SampleSnapshot()

	if err := server.store.SaveHosts(hosts); err != nil {
		return err
	}

	if err := server.store.SaveStatsState(samples); err != nil {
		return err
	}

	return nil
}

func (server *Server) stop() {
	server.stopOnce.Do(func() {
		close(server.stopChan)
		if server.listener != nil {
			_ = server.listener.Close()
		}
	})
}

func (server *Server) cleanup() {
	_ = server.persist()
	_ = os.Remove(config.SocketPath())
	_ = os.Remove(config.PidFilePath())
}

func cleanupStaleSocket() error {
	if pid, running := ReadRunningPid(); running {
		return fmt.Errorf("daemon already running with pid %d", pid)
	}

	_ = os.Remove(config.SocketPath())
	_ = os.Remove(config.PidFilePath())
	return nil
}

func isStopped(stopChan <-chan struct{}) bool {
	select {
	case <-stopChan:
		return true
	default:
		return false
	}
}

func DialSocket(request model.Request) (model.Response, error) {
	connection, err := net.DialTimeout("unix", config.SocketPath(), 2*time.Second)
	if err != nil {
		return model.Response{}, err
	}
	defer connection.Close()

	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))

	if err = json.NewEncoder(connection).Encode(request); err != nil {
		return model.Response{}, err
	}

	response := model.Response{}
	if err = json.NewDecoder(connection).Decode(&response); err != nil {
		return model.Response{}, err
	}

	return response, nil
}

func WaitForSocket(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, err := net.DialTimeout("unix", config.SocketPath(), 250*time.Millisecond)
		if err == nil {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func ContextWithTimeout(seconds int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
}
