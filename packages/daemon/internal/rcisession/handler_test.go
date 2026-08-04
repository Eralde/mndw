package rcisession

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

func TestHandlerControllerTestRequiresCSRFAndAlwaysReturnsVerdict(t *testing.T) {
	store := newFakeStore()
	service := NewService(store, &fakeEnumerator{})
	handler := NewHandler(service, &fakeControllerTester{verdict: ControllerInvalidToken}, nil)
	mux := http.NewServeMux()
	handler.Register(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/controller/test", strings.NewReader(`{"token":"secret-token"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status without CSRF = %d, want 403", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/controller/test", strings.NewReader(`{"token":"secret-token"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("response = %d headers=%v", response.Code, response.Header())
	}
	if strings.Contains(response.Body.String(), "secret-token") || !strings.Contains(response.Body.String(), "invalid-token") {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestHandlerSaveControllerPersistsOnlyValidToken(t *testing.T) {
	store := newFakeStore()
	service := NewService(store, &fakeEnumerator{})
	handler := NewHandler(service, &fakeControllerTester{verdict: ControllerValid}, nil)
	mux := http.NewServeMux()
	handler.Register(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/controller", strings.NewReader(`{"token":"valid-token"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if document.Controller == nil || document.Controller.Token != "valid-token" {
		t.Fatalf("controller = %#v", document.Controller)
	}
}

func TestHandlerRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	store := newFakeStore()
	service := NewService(store, &fakeEnumerator{})
	handler := NewHandler(service, &fakeControllerTester{verdict: ControllerValid}, nil)
	mux := http.NewServeMux()
	handler.Register(mux)

	for _, body := range []string{`{"token":"x","extra":true}`, `{"token":"x"}{"token":"y"}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/controller", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Mndw-Csrf", "1")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s status=%d, want 400", body, response.Code)
		}
	}
}

func TestHandlerCapabilityDoesNotExposeTokens(t *testing.T) {
	store := newFakeStore()
	store.document = model.Document{
		Controller: &model.TokenRecord{Token: "controller-secret", Support: model.SupportSupported},
		Extenders:  map[string]model.TokenRecord{"node-1": {Token: "extender-secret", Support: model.SupportSupported}},
	}
	service := NewService(store, &fakeEnumerator{members: structMember("node-1")})
	handler := NewHandler(service, &fakeControllerTester{verdict: ControllerValid}, nil)
	mux := http.NewServeMux()
	handler.Register(mux)

	request := httptest.NewRequest(http.MethodGet, "/api/mndw/rci-session/capability", nil)
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("capability response = %s", response.Body.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
}

func structMember(identity string) []enumeration.Member {
	return []enumeration.Member{{Identity: identity, Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}
}
