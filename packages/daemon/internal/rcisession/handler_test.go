package rcisession

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/minter"
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

func TestHandlerProvisionReturnsSafeReasonsForNonEmptyBatches(t *testing.T) {
	store := newFakeStore()
	enumerator := &fakeEnumerator{members: []enumeration.Member{
		{Identity: "node-http", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:01"},
		{Identity: "node-offline", MAC: "aa:bb:cc:dd:ee:02"},
		{Identity: "node-fail", IP: "192.168.1.4", MAC: "aa:bb:cc:dd:ee:03"},
	}}
	generator := handlerGeneratorFunc(func(_ context.Context, member enumeration.Member, _ minter.Credentials) (model.TokenRecord, error) {
		switch member.Identity {
		case "node-http":
			return model.TokenRecord{}, minter.ErrPersistentTokenRequiresHTTPS
		case "node-offline":
			return model.TokenRecord{}, minter.ErrMemberOffline
		default:
			return model.TokenRecord{}, minter.ErrTokenGenerationUnreachable
		}
	})
	handler := NewHandler(NewService(store, enumerator), &fakeControllerTester{verdict: ControllerValid}, generator)
	mux := http.NewServeMux()
	handler.Register(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/extenders/provision", strings.NewReader(`{"username":"admin","password":"password"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "password") || strings.Contains(response.Body.String(), "token") {
		t.Fatalf("response leaked secret: %s", response.Body.String())
	}
	var body struct {
		Extenders []struct {
			Identity string `json:"identity"`
			Support  string `json:"support"`
			Reason   string `json:"reason"`
		} `json:"extenders"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Extenders) != 3 || body.Extenders[0].Reason != "secure-endpoint-unavailable" || body.Extenders[1].Reason != "offline" || body.Extenders[2].Reason != "unreachable" {
		t.Fatalf("body = %#v", body.Extenders)
	}
}

func TestHandlerProvisionReturnsEmptySuccessfulEnumeration(t *testing.T) {
	handler := NewHandler(NewService(newFakeStore(), &fakeEnumerator{}), &fakeControllerTester{verdict: ControllerValid}, handlerGeneratorFunc(func(context.Context, enumeration.Member, minter.Credentials) (model.TokenRecord, error) {
		return model.TokenRecord{}, nil
	}))
	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/extenders/provision", strings.NewReader(`{"username":"admin","password":"password"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"extenders\":[]}\n" {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestHandlerProvisionReturnsTopLevelErrorForEnumerationFailure(t *testing.T) {
	enumerator := &fakeEnumerator{err: errors.New("controller down")}
	handler := NewHandler(NewService(newFakeStore(), enumerator), &fakeControllerTester{verdict: ControllerValid}, handlerGeneratorFunc(func(context.Context, enumeration.Member, minter.Credentials) (model.TokenRecord, error) {
		return model.TokenRecord{}, nil
	}))
	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/api/mndw/rci-session/extenders/provision", strings.NewReader(`{"username":"admin","password":"password"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "RCI_DEVICE_UNREACHABLE") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func structMember(identity string) []enumeration.Member {
	return []enumeration.Member{{Identity: identity, Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}}
}

type handlerGeneratorFunc func(context.Context, enumeration.Member, minter.Credentials) (model.TokenRecord, error)

func (f handlerGeneratorFunc) Generate(ctx context.Context, member enumeration.Member, credentials minter.Credentials) (model.TokenRecord, error) {
	return f(ctx, member, credentials)
}
