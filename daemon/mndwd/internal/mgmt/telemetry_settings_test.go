package mgmt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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
func (s *telemetryStoreStub) HasCapabilityGrant(string, string) bool        { return false }
func (s *telemetryStoreStub) SetCapabilityGrant(string, string, bool) error { return nil }

type telemetryEventPublisherStub struct {
	events []contractEvents.TelemetryGatheringChangedPayload
	err    error
	wake   chan contractEvents.TelemetryGatheringChangedPayload
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

	if s.wake != nil {
		s.wake <- payload
	}

	return s.err
}

type telemetrySessionStub struct {
	mu        sync.Mutex
	known     bool
	present   bool
	nextID    uint64
	observers map[uint64]func()
}

func (s *telemetrySessionStub) AuthModeKnown() bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.known
}

func (s *telemetrySessionStub) SessionPresent() bool {
	s.mu.Lock()

	defer s.mu.Unlock()

	return s.present
}

func (s *telemetrySessionStub) SubscribeMutations(observer func()) func() {
	s.mu.Lock()

	if s.observers == nil {
		s.observers = make(map[uint64]func())
	}

	s.nextID++
	id := s.nextID
	s.observers[id] = observer

	s.mu.Unlock()

	return func() {
		s.mu.Lock()

		defer s.mu.Unlock()

		delete(s.observers, id)
	}
}

func (s *telemetrySessionStub) mutate(known, present bool) {
	s.mu.Lock()

	s.known = known
	s.present = present
	observers := make([]func(), 0, len(s.observers))

	for _, observer := range s.observers {
		observers = append(observers, observer)
	}

	s.mu.Unlock()

	for _, observer := range observers {
		observer()
	}
}

func TestTelemetrySettingsRequiresCSRFAndPersistsAfterRuntimeTransition(t *testing.T) {
	controller := &telemetryControllerStub{}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
	events := &telemetryEventPublisherStub{}
	handler := newTelemetrySettingsHandler(store, controller, events)
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
		handler := newTelemetrySettingsHandler(store, controller, events)

		response := putTelemetry(t, handler, true)

		if response.Code != http.StatusNoContent || len(events.events) != 0 {
			t.Fatalf("PUT status=%d published events=%#v, want no event", response.Code, events.events)
		}
	})

	t.Run("SetEnabled fails", func(t *testing.T) {
		controller := &telemetryControllerStub{err: errors.New("runtime unavailable")}
		store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
		events := &telemetryEventPublisherStub{}
		handler := newTelemetrySettingsHandler(store, controller, events)

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
		handler := newTelemetrySettingsHandler(store, controller, events)

		response := putTelemetry(t, handler, true)

		if response.Code != http.StatusInternalServerError || len(events.events) != 0 {
			t.Fatalf("PUT status=%d published events=%#v, want no event", response.Code, events.events)
		}
	})
}

func TestTelemetrySessionLossDisablesBackgroundTelemetry(t *testing.T) {
	t.Run("controller token deleted", func(t *testing.T) {
		verifyTelemetrySessionLoss(t, true, func(session *telemetrySessionStub) {
			session.mutate(true, false)
		})
	})

	t.Run("auth mode already known at startup", func(t *testing.T) {
		verifyTelemetrySessionLoss(t, false, nil)
	})
}

func TestTelemetrySessionLossKeepsTelemetryForUnknownModeOrPresentSession(t *testing.T) {
	for _, test := range []struct {
		name    string
		known   bool
		present bool
	}{
		{name: "unknown auth mode", known: false, present: false},
		{name: "session still present", known: true, present: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())

			defer cancel()

			controller := &telemetryControllerStub{enabled: true}
			store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: true}}}
			wake := make(chan contractEvents.TelemetryGatheringChangedPayload, 1)
			events := &telemetryEventPublisherStub{wake: wake}
			session := &telemetrySessionStub{known: test.known, present: test.present}

			newTelemetrySettingsHandlerWithSession(store, controller, events, session, ctx)

			select {
			case event := <-wake:
				t.Fatalf("unexpected telemetry event: %#v", event)
			case <-time.After(30 * time.Millisecond):
			}

			if !store.state.Settings.BackgroundTelemetry || !controller.enabled || len(events.events) != 0 {
				t.Fatalf("telemetry changed for known=%t present=%t: state=%t controller=%t events=%#v", test.known, test.present, store.state.Settings.BackgroundTelemetry, controller.enabled, events.events)
			}
		})
	}
}

func verifyTelemetrySessionLoss(t *testing.T, initiallyPresent bool, mutate func(*telemetrySessionStub)) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	controller := &telemetryControllerStub{enabled: true}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: true}}}
	wake := make(chan contractEvents.TelemetryGatheringChangedPayload, 1)
	events := &telemetryEventPublisherStub{wake: wake}
	session := &telemetrySessionStub{known: true, present: initiallyPresent}

	newTelemetrySettingsHandlerWithSession(store, controller, events, session, ctx)

	if mutate != nil {
		mutate(session)
	}

	select {
	case event := <-wake:
		if event.Enabled {
			t.Fatalf("telemetry gathering event = %#v, want disabled", event)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for telemetry gathering event")
	}

	audit := store.state.Audit

	if store.state.Settings.BackgroundTelemetry || controller.enabled || len(controller.calls) != 1 || len(events.events) != 1 || len(audit) != 1 {
		t.Fatalf("telemetry transition state=%t controller=%t calls=%v events=%#v audit=%#v", store.state.Settings.BackgroundTelemetry, controller.enabled, controller.calls, events.events, audit)
	}

	if audit[0].Action != "telemetry" || audit[0].Detail != "disabled: background router access removed" {
		t.Fatalf("telemetry audit = %#v", audit[0])
	}
}

func TestTelemetrySettingsRejectsEnableWithoutSessionAndAllowsDisable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	defer cancel()

	controller := &telemetryControllerStub{}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
	events := &telemetryEventPublisherStub{}
	session := &telemetrySessionStub{known: true, present: false}
	handler := newTelemetrySettingsHandlerWithSession(store, controller, events, session, ctx)

	enable := putTelemetry(t, handler, true)

	if enable.Code != http.StatusConflict || !strings.Contains(enable.Body.String(), `"code":"CONFLICT"`) {
		t.Fatalf("enable without session status=%d body=%s", enable.Code, enable.Body.String())
	}

	disable := putTelemetry(t, handler, false)

	if disable.Code != http.StatusNoContent || store.state.Settings.BackgroundTelemetry || len(controller.calls) != 0 || len(events.events) != 0 {
		t.Fatalf("disable without session status=%d state=%t calls=%v events=%#v", disable.Code, store.state.Settings.BackgroundTelemetry, controller.calls, events.events)
	}
}

func TestTelemetryTransitionRejectsEnableWhenSessionIsAbsent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	controller := &telemetryControllerStub{}
	store := &telemetryStoreStub{state: state.State{Settings: state.Settings{BackgroundTelemetry: false}}}
	events := &telemetryEventPublisherStub{}
	session := &telemetrySessionStub{known: true, present: false}
	handler := newTelemetrySettingsHandlerWithSession(store, controller, events, session, ctx)

	err := handler.telemetry.transition(true, "enabled")

	if err == nil || err.Status != http.StatusConflict || err.Code != "CONFLICT" {
		t.Fatalf("transition enable without session error = %v, want 409 CONFLICT", err)
	}

	if store.state.Settings.BackgroundTelemetry || controller.enabled || len(controller.calls) != 0 || len(events.events) != 0 {
		t.Fatalf("transition changed telemetry without session: state=%t controller=%t calls=%v events=%#v", store.state.Settings.BackgroundTelemetry, controller.enabled, controller.calls, events.events)
	}
}

func newTelemetrySettingsHandler(store StateStore, controller TelemetryController, events ManagementEventPublisher) *Handler {
	ctx, cancel := context.WithCancel(context.Background())

	cancel()

	return newTelemetrySettingsHandlerWithSession(
		store,
		controller,
		events,
		&telemetrySessionStub{known: true, present: true},
		ctx,
	)
}

func newTelemetrySettingsHandlerWithSession(
	store StateStore,
	controller TelemetryController,
	events ManagementEventPublisher,
	session TelemetrySession,
	lifetime context.Context,
) *Handler {
	return New(Config{
		Runtime:             passthroughRuntime{},
		Store:               store,
		TelemetryController: controller,
		TelemetrySession:    session,
		EventPublisher:      events,
		Logger:              discardLogger(),
		ServiceActionRoot:   lifetime,
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
