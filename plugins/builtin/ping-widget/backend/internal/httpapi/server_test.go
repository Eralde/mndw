package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"ping-widget/internal/model"
)

type fakeService struct {
	hosts        []model.Host
	running      bool
	persistCalls int
	persistErr   error
}

func (service *fakeService) Stats() []model.HostStats { return []model.HostStats{} }
func (service *fakeService) Hosts() []model.Host      { return service.hosts }
func (service *fakeService) Running() bool            { return service.running }
func (service *fakeService) SetRunning(running bool)  { service.running = running }
func (service *fakeService) UpdateHosts(input model.HostUpdateInput) ([]model.Host, error) {
	service.hosts = append(service.hosts, model.Host{IP: input.IP, Name: input.Name})
	return service.hosts, nil
}
func (service *fakeService) Persist() error {
	service.persistCalls++
	return service.persistErr
}

func TestControlRoutes(t *testing.T) {
	service := &fakeService{running: true}
	handler := newMux(&Server{service: service})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://mndw/control", nil)
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"running\":true}\n" {
		t.Fatalf("control GET = %d %q", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"stop"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"running\":false}\n" {
		t.Fatalf("control stop = %d %q", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"stop"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"running\":false}\n" {
		t.Fatalf("repeated control stop = %d %q", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"start"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"running\":true}\n" {
		t.Fatalf("control start = %d %q", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"invalid"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	var controlError map[string]string
	if err := json.NewDecoder(response.Body).Decode(&controlError); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusBadRequest || controlError["error"] != "INVALID_CONTROL_ACTION" {
		t.Fatalf("invalid control action = %d %#v", response.Code, controlError)
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader("{"))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	controlError = nil
	if err := json.NewDecoder(response.Body).Decode(&controlError); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusBadRequest || controlError["error"] != "BAD_REQUEST" {
		t.Fatalf("invalid control JSON = %d %#v", response.Code, controlError)
	}
}

func TestReadyAndHostRoutes(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "ping-httpapi-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	socket := filepath.Join(root, "backend.sock")
	if err := os.Setenv("MNDW_BACKEND_SOCKET", socket); err != nil {
		t.Fatal(err)
	}
	if err := os.Setenv("MNDW_PLUGIN_ID", "ping-widget"); err != nil {
		t.Fatal(err)
	}
	if err := os.Setenv("MNDW_BACKEND_PROTOCOL", "1"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Unsetenv("MNDW_BACKEND_SOCKET")
		_ = os.Unsetenv("MNDW_PLUGIN_ID")
		_ = os.Unsetenv("MNDW_BACKEND_PROTOCOL")
	})
	service := &fakeService{running: true}
	server, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- server.Run(ctx) }()
	for attempt := 0; attempt < 100; attempt++ {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(250 * time.Millisecond)
	select {
	case serviceErr := <-runErr:
		if errors.Is(serviceErr, syscall.EPERM) {
			t.Skip("sandbox does not permit Unix socket listeners")
		}
		t.Fatalf("service exited before readiness: %v", serviceErr)
	default:
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	client := &http.Client{Transport: transport}
	defer transport.CloseIdleConnections()
	response, err := client.Get("http://mndw/_mndw/ready")
	if err != nil {
		select {
		case serverErr := <-runErr:
			t.Fatalf("service exited before readiness: %v", serverErr)
		default:
		}
		t.Fatal(err)
	}
	defer response.Body.Close()
	var ready map[string]any
	if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || ready["pluginId"] != "ping-widget" {
		t.Fatalf("ready = %d %#v", response.StatusCode, ready)
	}

	request := httptest.NewRequest(http.MethodPost, "http://mndw/hosts", strings.NewReader(`{"ip":"192.0.2.1","name":"router"}`))
	request.Header.Set("Content-Type", "application/json")
	request.URL.Scheme = "http"
	request.URL.Host = "mndw"
	request.RequestURI = ""
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || len(service.hosts) != 1 {
		t.Fatalf("host update = %d %#v", response.StatusCode, service.hosts)
	}

	response, err = client.Get("http://mndw/control")
	if err != nil {
		t.Fatal(err)
	}
	var controlState map[string]bool
	if err := json.NewDecoder(response.Body).Decode(&controlState); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !controlState["running"] {
		t.Fatalf("control GET = %d %#v", response.StatusCode, controlState)
	}

	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"stop"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RequestURI = ""
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	controlState = nil
	if err := json.NewDecoder(response.Body).Decode(&controlState); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || controlState["running"] {
		t.Fatalf("control stop = %d %#v", response.StatusCode, controlState)
	}

	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"stop"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RequestURI = ""
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	controlState = nil
	if err := json.NewDecoder(response.Body).Decode(&controlState); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || controlState["running"] {
		t.Fatalf("repeated control stop = %d %#v", response.StatusCode, controlState)
	}

	request = httptest.NewRequest(http.MethodPost, "http://mndw/control", strings.NewReader(`{"action":"invalid"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RequestURI = ""
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var controlError map[string]string
	if err := json.NewDecoder(response.Body).Decode(&controlError); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || controlError["error"] != "INVALID_CONTROL_ACTION" {
		t.Fatalf("invalid control action = %d %#v", response.StatusCode, controlError)
	}
}

func TestRunPersistsOnceAfterCleanShutdown(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "ping-shutdown-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	socket := filepath.Join(root, "backend.sock")
	t.Setenv("MNDW_BACKEND_SOCKET", socket)

	service := &fakeService{}
	server, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- server.Run(ctx) }()

	for attempt := 0; attempt < 100; attempt++ {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		select {
		case serviceErr := <-runErr:
			if errors.Is(serviceErr, syscall.EPERM) {
				t.Skip("sandbox does not permit Unix socket listeners")
			}
			t.Fatalf("service exited before socket creation: %v", serviceErr)
		default:
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("socket was not created: %v", err)
	}

	cancel()
	if err := <-runErr; err != nil {
		t.Fatalf("clean shutdown = %v", err)
	}
	if service.persistCalls != 1 {
		t.Fatalf("Persist calls = %d, want 1", service.persistCalls)
	}
}

func TestRunReturnsPersistErrorAfterCleanShutdown(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "ping-shutdown-error-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	socket := filepath.Join(root, "backend.sock")
	t.Setenv("MNDW_BACKEND_SOCKET", socket)

	persistErr := errors.New("persist failed")
	service := &fakeService{persistErr: persistErr}
	server, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- server.Run(ctx) }()

	for attempt := 0; attempt < 100; attempt++ {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		select {
		case serviceErr := <-runErr:
			if errors.Is(serviceErr, syscall.EPERM) {
				t.Skip("sandbox does not permit Unix socket listeners")
			}
			t.Fatalf("service exited before socket creation: %v", serviceErr)
		default:
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("socket was not created: %v", err)
	}

	cancel()
	if err := <-runErr; !errors.Is(err, persistErr) {
		t.Fatalf("clean shutdown error = %v, want %v", err, persistErr)
	}
	if service.persistCalls != 1 {
		t.Fatalf("Persist calls = %d, want 1", service.persistCalls)
	}
}

func TestRunDoesNotPersistAfterServerError(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "ping-server-error-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	parent := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(parent, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MNDW_BACKEND_SOCKET", filepath.Join(parent, "backend.sock"))

	service := &fakeService{}
	server, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Run(context.Background()); err == nil {
		t.Fatal("Run succeeded with a file as the socket parent")
	}
	if service.persistCalls != 0 {
		t.Fatalf("Persist calls = %d, want 0", service.persistCalls)
	}
}
