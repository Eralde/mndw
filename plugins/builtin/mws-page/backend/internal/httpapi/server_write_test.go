package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"mws-page/internal/config"
	"mws-page/internal/persistent"
	"mws-page/internal/service"
)

type writeBackend struct{}

func (writeBackend) Run(context.Context) {}

func (writeBackend) Snapshot() []persistent.Session { return nil }

func (writeBackend) Diagnostics() persistent.Diagnostics { return persistent.Diagnostics{} }

func (writeBackend) HasTarget(string) bool { return true }

func (writeBackend) Send(context.Context, string, persistent.Request) (persistent.Response, error) {
	return persistent.Response{Status: http.StatusOK, Body: []byte(`[{"interface":{"power":{"status":[{"status":"message"}]}}}]`)}, nil
}

func TestWriteRouteDecodesAndDelegates(t *testing.T) {
	backend := service.New(config.Config{})

	backend.SetPersistentSource(writeBackend{})

	server := &Server{service: backend}
	mux := http.NewServeMux()

	mux.HandleFunc(`POST /write`, server.write)

	request := httptest.NewRequest(http.MethodPost, `/write`, bytes.NewBufferString(`{"operation":"wifi.set-power","nodeId":"cid-1","params":{"interface":"WifiMaster0","power":75,"persist":false}}`))
	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf(`status = %d, body = %s`, response.Code, response.Body.String())
	}

	if response.Header().Get(`Content-Type`) != `application/json` {
		t.Fatalf(`content type = %q`, response.Header().Get(`Content-Type`))
	}
}

func TestWriteRouteRejectsWrongMethod(t *testing.T) {
	server := &Server{service: service.New(config.Config{})}
	mux := http.NewServeMux()

	mux.HandleFunc(`POST /write`, server.write)

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, `/write`, nil))

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf(`status = %d, want 405`, response.Code)
	}
}
