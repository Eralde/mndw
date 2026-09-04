package mgmt

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/state"
)

type telemetryControllerStub struct {
	enabled bool
	calls   []bool
}

func (s *telemetryControllerStub) IsEnabled() bool {
	return s.enabled
}

func (s *telemetryControllerStub) SetEnabled(_ context.Context, enabled bool) error {
	s.calls = append(s.calls, enabled)
	s.enabled = enabled

	return nil
}

type telemetryStoreStub struct {
	state state.State
}

func (s *telemetryStoreStub) Get(string) (*state.Plugin, bool) { return nil, false }
func (s *telemetryStoreStub) Snapshot() *state.State {
	copy := s.state

	return &copy
}
func (s *telemetryStoreStub) Mutate(mutate func(*state.State) error) error {
	return mutate(&s.state)
}
func (s *telemetryStoreStub) HasGrant(string, string) bool        { return false }
func (s *telemetryStoreStub) SetGrant(string, string, bool) error { return nil }

func TestTelemetrySettingsRequiresCSRFAndPersistsAfterRuntimeTransition(t *testing.T) {
	controller := &telemetryControllerStub{}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
	handler := &Handler{
		cfg:       Config{ServiceActionRoot: context.Background()},
		store:     store,
		telemetry: controller,
		logger:    nil,
	}
	mux := http.NewServeMux()

	handler.Register(mux)

	get := httptest.NewRecorder()

	mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/mgmt/telemetry", nil))

	if get.Code != http.StatusOK {
		t.Fatalf("GET status %d", get.Code)
	}

	var body telemetrySettingsDTO

	if err := json.Unmarshal(get.Body.Bytes(), &body); err != nil || body.Enabled {
		t.Fatalf("GET body %q", get.Body.String())
	}

	withoutCSRF := httptest.NewRecorder()

	mux.ServeHTTP(withoutCSRF, httptest.NewRequest(http.MethodPut, "/api/mgmt/telemetry", strings.NewReader(`{"enabled":true}`)))

	if withoutCSRF.Code != http.StatusForbidden {
		t.Fatalf("PUT without CSRF status %d", withoutCSRF.Code)
	}

	request := httptest.NewRequest(http.MethodPut, "/api/mgmt/telemetry", strings.NewReader(`{"enabled":true}`))

	request.Header.Set("X-Mndw-Csrf", "1")

	response := httptest.NewRecorder()

	mux.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || !store.state.Settings.BackgroundTelemetry || len(controller.calls) != 1 || !controller.calls[0] {
		t.Fatalf("PUT status=%d state=%v calls=%v", response.Code, store.state.Settings.BackgroundTelemetry, controller.calls)
	}
}
