package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	contractEvents "mndw.local/contracts/events"
	"mndwd/internal/state"
)

type telemetryControllerStub struct {
	enabled bool
	calls   []bool
	err     error
}

func (s *telemetryControllerStub) IsEnabled() bool {
	return s.enabled
}

func (s *telemetryControllerStub) SetEnabled(_ context.Context, enabled bool) error {
	s.calls = append(s.calls, enabled)
	if s.err != nil {
		return s.err
	}

	s.enabled = enabled

	return nil
}

type telemetryStoreStub struct {
	state     state.State
	mutateErr error
}

func (s *telemetryStoreStub) Get(string) (*state.Plugin, bool) { return nil, false }
func (s *telemetryStoreStub) Snapshot() *state.State {
	copy := s.state

	return &copy
}
func (s *telemetryStoreStub) Mutate(mutate func(*state.State) error) error {
	if s.mutateErr != nil {
		return s.mutateErr
	}

	return mutate(&s.state)
}
func (s *telemetryStoreStub) HasGrant(string, string) bool        { return false }
func (s *telemetryStoreStub) SetGrant(string, string, bool) error { return nil }

type telemetryEventPublisherStub struct {
	events []contractEvents.TelemetryGatheringChangedPayload
	err    error
}

func (s *telemetryEventPublisherStub) PublishPluginInstalled(contractEvents.PluginInstalledPayload) error {
	return nil
}
func (s *telemetryEventPublisherStub) PublishPluginApproved(contractEvents.PluginApprovedPayload) error {
	return nil
}
func (s *telemetryEventPublisherStub) PublishPluginRemoved(contractEvents.PluginRemovedPayload) error {
	return nil
}
func (s *telemetryEventPublisherStub) PublishTelemetryGatheringChanged(payload contractEvents.TelemetryGatheringChangedPayload) error {
	s.events = append(s.events, payload)

	return s.err
}

func TestTelemetrySettingsRequiresCSRFAndPersistsAfterRuntimeTransition(t *testing.T) {
	controller := &telemetryControllerStub{}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
	events := &telemetryEventPublisherStub{}
	handler := &Handler{
		cfg:            Config{ServiceActionRoot: context.Background()},
		store:          store,
		telemetry:      controller,
		eventPublisher: events,
		logger:         nil,
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
	if len(events.events) != 1 || events.events[0].Enabled != true {
		t.Fatalf("published events = %#v, want one event with enabled=true", events.events)
	}
}

func TestTelemetrySettingsPublishesOnlyAfterStateTransitionSucceeds(t *testing.T) {
	t.Run("same value", func(t *testing.T) {
		controller := &telemetryControllerStub{enabled: true}
		store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: true}}}
		events := &telemetryEventPublisherStub{}
		handler := &Handler{
			cfg:            Config{ServiceActionRoot: context.Background()},
			store:          store,
			telemetry:      controller,
			eventPublisher: events,
		}

		response := putTelemetry(t, handler, true)

		if response.Code != http.StatusNoContent || len(events.events) != 0 {
			t.Fatalf("PUT status=%d published events=%#v, want no event", response.Code, events.events)
		}
	})

	t.Run("SetEnabled fails", func(t *testing.T) {
		controller := &telemetryControllerStub{err: errors.New("runtime unavailable")}
		store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
		events := &telemetryEventPublisherStub{}
		handler := &Handler{
			cfg:            Config{ServiceActionRoot: context.Background()},
			store:          store,
			telemetry:      controller,
			eventPublisher: events,
			logger:         discardLogger(),
		}

		response := putTelemetry(t, handler, true)

		if response.Code != http.StatusBadGateway || len(events.events) != 0 {
			t.Fatalf("PUT status=%d published events=%#v, want no event", response.Code, events.events)
		}
	})

	t.Run("Mutate fails", func(t *testing.T) {
		controller := &telemetryControllerStub{}
		store := &telemetryStoreStub{
			state:     state.State{Settings: state.Settings{BackgroundTelemetry: false}},
			mutateErr: errors.New("state unavailable"),
		}
		events := &telemetryEventPublisherStub{}
		handler := &Handler{
			cfg:            Config{ServiceActionRoot: context.Background()},
			store:          store,
			telemetry:      controller,
			eventPublisher: events,
		}

		response := putTelemetry(t, handler, true)

		if response.Code != http.StatusInternalServerError || len(events.events) != 0 {
			t.Fatalf("PUT status=%d published events=%#v, want no event", response.Code, events.events)
		}
	})
}

func putTelemetry(t *testing.T, handler *Handler, enabled bool) *httptest.ResponseRecorder {
	t.Helper()

	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodPut, "/api/mgmt/telemetry", strings.NewReader(`{"enabled":`+map[bool]string{true: "true", false: "false"}[enabled]+`}`))
	request.Header.Set("X-Mndw-Csrf", "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	return response
}
