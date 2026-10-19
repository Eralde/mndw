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
	service := NewService(store, nil)

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

func TestHandlerRemovedExtenderRoutesReturnNotFound(t *testing.T) {
	handler := NewHandler(NewService(&testServiceStore{}, serviceTestEnumerator{}), serviceTestControllerTester{})
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
