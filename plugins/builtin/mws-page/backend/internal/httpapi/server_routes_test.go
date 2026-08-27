package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"mws-page/internal/config"
	"mws-page/internal/service"
)

func TestHandlerExposesPersistentNodesAndRemovesCredentialRoutes(t *testing.T) {
	server := &Server{service: service.New(config.Config{})}
	handler := server.handler()

	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/nodes", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("GET /nodes status = %d, body = %s", response.Code, response.Body.String())
	}

	var envelope map[string]any

	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}

	if envelope["lastRefreshAt"] != nil || envelope["persistentAvailable"] != false {
		t.Fatalf("nodes envelope = %#v", envelope)
	}

	if sessions, ok := envelope["persistentSessions"].([]any); !ok || len(sessions) != 0 {
		t.Fatalf("persistentSessions = %#v", envelope["persistentSessions"])
	}

	for _, route := range []string{"/credentials", "/forget", "/snapshot"} {
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))

		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", route, response.Code)
		}
	}
}

func TestHandlerKeepsWriteRoute(t *testing.T) {
	server := &Server{service: service.New(config.Config{})}
	handler := server.handler()
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/write", nil).WithContext(context.Background()))

	if response.Code != http.StatusBadRequest {
		t.Fatalf("POST /write status = %d, want 400", response.Code)
	}
}
