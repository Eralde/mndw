package rcisession

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

func TestHandlerCapabilityProjectsSafeManagerStates(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "secret", Support: model.SupportSupported}}}
	service := newTestService(t, ServiceConfig{Store: store})

	service.SessionManager().ApplyEnumeration([]enumeration.Member{
		{Identity: "bad", Name: "Bad", MAC: "aa:bb:cc:dd:ee:01", FQDN: "bad.keenetic.io"},
		{Identity: "good", Name: "Good", IP: "192.0.2.1", MAC: "aa:bb:cc:dd:ee:02", FQDN: "good.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true},
	})

	handler := NewHandler(service, serviceTestControllerTester{})
	mux := http.NewServeMux()

	handler.Register(mux)

	request := httptest.NewRequest(http.MethodGet, "/api/mndw/rci-session/capability", nil)

	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}

	var body map[string]any

	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
}

func TestHandlerCapabilityReportsTokenlessMode(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: &testEnabledStore{enabled: true, set: true}, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})
	response := serveHandlerRequest(t, service, serviceTestControllerTester{}, http.MethodGet, "/api/mndw/rci-session/capability", "", true)
	var body struct {
		Controller ControllerCapability `json:"controller"`
	}

	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if response.Code != http.StatusOK || body.Controller.Support != model.SupportSupported || body.Controller.Auth != AuthModeNone || !body.Controller.Enabled || body.Controller.LastCheckedAt != nil {
		t.Fatalf("status=%d controller=%#v body=%s", response.Code, body.Controller, response.Body.String())
	}
}

func TestHandlerCapabilityReportsNeedsToken(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: &testEnabledStore{enabled: true, set: true}, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})
	response := serveHandlerRequest(t, service, serviceTestControllerTester{}, http.MethodGet, "/api/mndw/rci-session/capability", "", true)
	var body struct {
		Controller ControllerCapability `json:"controller"`
	}

	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if response.Code != http.StatusOK || body.Controller.Support != model.SupportNeedsToken || body.Controller.Auth != AuthModeToken || !body.Controller.Enabled {
		t.Fatalf("status=%d controller=%#v body=%s", response.Code, body.Controller, response.Body.String())
	}
}

func TestHandlerCapabilityReprobesUnknownMode(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: &testEnabledStore{enabled: true, set: true}, AuthModeSource: &sequenceAuthModeSource{modes: []AuthMode{AuthModeUnknown, AuthModeNone}}})
	handler := NewHandler(service, serviceTestControllerTester{})
	mux := http.NewServeMux()

	handler.Register(mux)

	for index, want := range []AuthMode{AuthModeUnknown, AuthModeNone} {
		request := httptest.NewRequest(http.MethodGet, "/api/mndw/rci-session/capability", nil)

		request.Header.Set("X-Mndw-Csrf", "1")

		response := httptest.NewRecorder()

		mux.ServeHTTP(response, request)

		var body struct {
			Controller ControllerCapability `json:"controller"`
		}

		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}

		if response.Code != http.StatusOK || body.Controller.Auth != want {
			t.Fatalf("request %d: status=%d auth=%q want=%q body=%s", index, response.Code, body.Controller.Auth, want, response.Body.String())
		}
	}
}

func TestHandlerPutEnabled(t *testing.T) {
	tests := []struct {
		name       string
		mode       AuthMode
		tester     ControllerTester
		body       string
		csrf       bool
		wantStatus int
		wantCode   string
		wantResult string
	}{
		{name: "CSRF missing", mode: AuthModeNone, body: `{"enabled":true}`, wantStatus: http.StatusForbidden, wantCode: "CSRF_REQUIRED"},
		{name: "token mode", mode: AuthModeToken, body: `{"enabled":true}`, csrf: true, wantStatus: http.StatusConflict, wantCode: "RCI_AUTH_MODE_MISMATCH"},
		{name: "none valid", mode: AuthModeNone, tester: serviceTestControllerTester{}, body: `{"enabled":true}`, csrf: true, wantStatus: http.StatusOK, wantResult: "enabled"},
		{name: "none unreachable", mode: AuthModeNone, tester: serviceTestTesterFunc(func(context.Context, string) (ControllerVerdict, error) { return ControllerUnreachable, nil }), body: `{"enabled":true}`, csrf: true, wantStatus: http.StatusBadGateway, wantCode: "RCI_DEVICE_UNREACHABLE"},
		{name: "disabled", mode: AuthModeNone, body: `{"enabled":false}`, csrf: true, wantStatus: http.StatusOK, wantResult: "disabled"},
		{name: "extra field", mode: AuthModeNone, body: `{"enabled":true,"extra":1}`, csrf: true, wantStatus: http.StatusBadRequest, wantCode: "BAD_REQUEST"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: &testEnabledStore{}, AuthModeSource: testAuthModeSource{mode: test.mode}})
			response := serveHandlerRequest(t, service, test.tester, http.MethodPut, "/api/mndw/rci-session/enabled", test.body, test.csrf)

			if response.Code != test.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.wantStatus, response.Body.String())
			}

			if test.wantCode != "" && !strings.Contains(response.Body.String(), test.wantCode) {
				t.Fatalf("body=%s want code %q", response.Body.String(), test.wantCode)
			}

			if test.wantResult != "" && !strings.Contains(response.Body.String(), `"result":"`+test.wantResult+`"`) {
				t.Fatalf("body=%s want result %q", response.Body.String(), test.wantResult)
			}
		})
	}
}

func serveHandlerRequest(t *testing.T, service *Service, tester ControllerTester, method, path, body string, csrf bool) *httptest.ResponseRecorder {
	t.Helper()

	handler := NewHandler(service, tester)
	mux := http.NewServeMux()

	handler.Register(mux)

	request := httptest.NewRequest(method, path, strings.NewReader(body))

	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}

	if csrf {
		request.Header.Set("X-Mndw-Csrf", "1")
	}

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	return response
}

func TestHandlerRemovedExtenderRoutesReturnNotFound(t *testing.T) {
	handler := NewHandler(newTestService(t, ServiceConfig{Store: &testServiceStore{}, Enumerator: serviceTestEnumerator{}}), serviceTestControllerTester{})
	mux := http.NewServeMux()

	handler.Register(mux)

	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		request := httptest.NewRequest(method, "/api/mndw/rci-session/extenders/provision", strings.NewReader(`{"username":"admin"}`))

		request.Header.Set("X-Mndw-Csrf", "1")

		response := httptest.NewRecorder()

		mux.ServeHTTP(response, request)

		if response.Code != http.StatusNotFound {
			t.Fatalf("%s removed route status = %d", method, response.Code)
		}
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/mndw/rci-session/extenders", nil)

	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("DELETE extenders status = %d, want 404", response.Code)
	}
}

type serviceTestEnumerator struct{}

func (serviceTestEnumerator) List(context.Context) ([]enumeration.Member, error) { return nil, nil }
func (serviceTestEnumerator) Invalidate()                                        {}
