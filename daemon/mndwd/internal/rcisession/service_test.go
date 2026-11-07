package rcisession

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/sessionmanager"
)

func TestServiceResolveUsesManagerClassification(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	manager := sessionmanager.New()
	service := newTestService(t, ServiceConfig{Store: store, Manager: manager})

	manager.ApplyEnumeration([]enumeration.Member{{Identity: "bad", MAC: "aa:bb:cc:dd:ee:01", FQDN: "bad.keenetic.io"}})

	if _, err := service.Resolve(context.Background(), "bad"); !errors.Is(err, proxy.ErrUnsupported) {
		t.Fatalf("ineligible resolve = %v", err)
	}

	if _, err := service.Resolve(context.Background(), "unknown"); !errors.Is(err, proxy.ErrNoSession) {
		t.Fatalf("unknown resolve = %v", err)
	}
}

func TestServiceResolveControllerCapturesEpoch(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	service := newTestService(t, ServiceConfig{Store: store})
	destination, err := service.Resolve(context.Background(), "controller")
	if err != nil || destination.Token != "controller" || destination.ControllerEpoch != 0 {
		t.Fatalf("destination = %#v, err=%v", destination, err)
	}

	service.InvalidateController(0)

	if _, err := service.Resolve(context.Background(), "controller"); !errors.Is(err, ErrControllerInvalid) {
		t.Fatalf("invalid controller resolve = %v", err)
	}
}

func TestServiceSaveAndDeleteControllerBumpRuntimeTrust(t *testing.T) {
	store := &testServiceStore{}
	service := newTestService(t, ServiceConfig{Store: store})
	tester := serviceTestControllerTester{}

	if _, err := service.SaveController(context.Background(), tester, "controller"); err != nil {
		t.Fatal(err)
	}

	if service.ControllerEpoch() != 1 {
		t.Fatalf("epoch after save = %d", service.ControllerEpoch())
	}

	if err := service.DeleteController(); err != nil {
		t.Fatal(err)
	}

	if service.ControllerEpoch() != 2 {
		t.Fatalf("epoch after delete = %d", service.ControllerEpoch())
	}
}

func TestControllerTesterErrorsAreLoggedWithoutToken(t *testing.T) {
	for _, operation := range []struct {
		name string
		call func(*Service, ControllerTester, string) (ControllerVerdict, error)
	}{
		{
			name: "test",
			call: func(service *Service, tester ControllerTester, token string) (ControllerVerdict, error) {
				return service.TestController(context.Background(), tester, token)
			},
		},
		{
			name: "save",
			call: func(service *Service, tester ControllerTester, token string) (ControllerVerdict, error) {
				return service.SaveController(context.Background(), tester, token)
			},
		},
	} {
		t.Run(operation.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
			service := newTestService(t, ServiceConfig{
				Store:         &testServiceStore{},
				ControllerURL: "http://192.0.2.7:79",
				Logger:        logger,
			})
			tester := serviceTestTesterFunc(func(context.Context, string) (ControllerVerdict, error) {
				return ControllerUnreachable, errors.New("connection refused")
			})
			const token = "controller-secret-must-not-be-logged"

			verdict, err := operation.call(service, tester, token)
			if verdict != ControllerUnreachable || err == nil {
				t.Fatalf("controller operation = %q, %v; want unreachable error", verdict, err)
			}

			output := logs.String()
			for _, field := range []string{"WARN", "controller " + operation.name + " failed", "verdict=unreachable", `error="connection refused"`, "host=192.0.2.7:79"} {
				if !strings.Contains(output, field) {
					t.Errorf("warning log %q missing %q", output, field)
				}
			}

			if strings.Contains(output, token) {
				t.Fatalf("warning log leaked controller token: %q", output)
			}
		})
	}
}

func TestServiceAuthURLCapturesTokenAndParsesRelayURL(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller-secret", Support: model.SupportSupported}}}
	client := &http.Client{Transport: testRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/rci/" || request.Header.Get("X-Ndma-Tkn") != "controller-secret" {
			t.Fatalf("request = %s token=%q", request.URL.Path, request.Header.Get("X-Ndma-Tkn"))
		}

		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"mws":{"member":{"auth-url":{"url":"https://node.keenetic.io/auth?x-ndma-tkn=relay"}}}}]`))}, nil
	})}
	service := newTestService(t, ServiceConfig{Store: store, ControllerURL: "http://192.0.2.1", HTTPClient: client})

	url, epoch, err := service.AuthURL(context.Background(), "node")
	if err != nil || url != "https://node.keenetic.io/auth?x-ndma-tkn=relay" || epoch != 0 {
		t.Fatalf("AuthURL() = %q, %d, %v", url, epoch, err)
	}
}

func TestServiceAuthURLPreservesUnauthorizedStatusForEpochInvalidation(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller-secret", Support: model.SupportSupported}}}
	client := &http.Client{Transport: testRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("secret"))}, nil
	})}
	service := newTestService(t, ServiceConfig{Store: store, HTTPClient: client})

	_, _, err := service.AuthURL(context.Background(), "node")
	var httpError *rci.HTTPError

	if !errors.As(err, &httpError) || httpError.StatusCode != http.StatusUnauthorized {
		t.Fatalf("AuthURL() error = %v", err)
	}
}

func TestServiceSessionPresentMigratesFromToken(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	service := newTestService(t, ServiceConfig{Store: store, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if !service.SessionPresent() {
		t.Fatal("stored token should enable migrated session")
	}

	service = newTestService(t, ServiceConfig{Store: &testServiceStore{}, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if service.SessionPresent() {
		t.Fatal("session without token should be absent")
	}
}

func TestServiceWithoutAuthModeSourceActsAsTokenMode(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}})

	if service.AuthMode() != AuthModeToken || !service.SessionPresent() {
		t.Fatalf("mode=%q session=%t", service.AuthMode(), service.SessionPresent())
	}
}

func TestServiceTokenlessResolveOmitsToken(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})

	destination, err := service.Resolve(context.Background(), "controller")
	if err != nil || !destination.Controller || destination.Token != "" || destination.Support != model.SupportSupported {
		t.Fatalf("destination=%#v err=%v", destination, err)
	}

	enabled.enabled = false

	if _, err := service.Resolve(context.Background(), "controller"); !errors.Is(err, proxy.ErrNoSession) {
		t.Fatalf("disabled resolve = %v", err)
	}
}

func TestServiceTokenlessIgnoresBrokenTokenStore(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: panicServiceStore{t: t}, EnabledStore: &testEnabledStore{}, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})

	verdict, err := service.SetTokenlessEnabled(context.Background(), serviceTestControllerTester{}, true)
	if err != nil || verdict != ControllerValid || !service.SessionPresent() || !service.CaptureController().Active {
		t.Fatalf("verdict=%q err=%v present=%t snapshot=%#v", verdict, err, service.SessionPresent(), service.CaptureController())
	}
}

func TestServiceSetTokenlessEnabledRejectsTokenMode(t *testing.T) {
	enabled := &testEnabledStore{}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	_, err := service.SetTokenlessEnabled(context.Background(), serviceTestControllerTester{}, true)
	if !errors.Is(err, ErrAuthModeMismatch) || enabled.set {
		t.Fatalf("err=%v enabled=(%t,%t)", err, enabled.enabled, enabled.set)
	}
}

func TestServiceSetTokenlessEnabledRequiresValidProbe(t *testing.T) {
	enabled := &testEnabledStore{}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})

	verdict, err := service.SetTokenlessEnabled(context.Background(), serviceTestTesterFunc(func(context.Context, string) (ControllerVerdict, error) {
		return ControllerUnreachable, errors.New("offline")
	}), true)
	if verdict != ControllerUnreachable || err == nil || enabled.set {
		t.Fatalf("verdict=%q err=%v enabled=(%t,%t)", verdict, err, enabled.enabled, enabled.set)
	}
}

func TestServiceNeedsTokenAfterModeChange(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if support := service.ControllerSupport(); support != model.SupportNeedsToken {
		t.Fatalf("support = %q", support)
	}

	if service.SessionPresent() || service.CaptureController().Active {
		t.Fatal("enabled token mode without token must not present a session")
	}
}

func TestServiceDetectAuthModeNotifiesOnFirstKnownMode(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, AuthModeSource: &sequenceAuthModeSource{modes: []AuthMode{AuthModeUnknown, AuthModeNone, AuthModeNone}}})
	notifications := 0

	service.SubscribeMutations(func() { notifications++ })

	for range 3 {
		service.DetectAuthMode(context.Background())
	}

	if notifications != 1 {
		t.Fatalf("mutation notifications = %d, want 1", notifications)
	}
}

func TestSubscribeMutationsReceivesNotify(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}})
	notifications := 0

	service.SubscribeMutations(func() {
		_ = service.ControllerEpoch()
		notifications++
	})

	if err := service.DeleteController(); err != nil {
		t.Fatal(err)
	}

	if notifications != 1 {
		t.Fatalf("mutation notifications = %d, want 1", notifications)
	}
}

func TestServiceAuthURLTokenlessOmitsHeader(t *testing.T) {
	client := &http.Client{Transport: testRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("X-Ndma-Tkn") != "" {
			t.Fatalf("tokenless auth-url sent token header %q", request.Header.Get("X-Ndma-Tkn"))
		}

		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"mws":{"member":{"auth-url":{"url":"https://node.keenetic.io/auth?x-ndma-tkn=relay"}}}}]`))}, nil
	})}
	service := newTestService(t, ServiceConfig{
		Store:          &testServiceStore{},
		EnabledStore:   &testEnabledStore{enabled: true, set: true},
		AuthModeSource: testAuthModeSource{mode: AuthModeNone},
		HTTPClient:     client,
	})

	if _, _, err := service.AuthURL(context.Background(), "node"); err != nil {
		t.Fatal(err)
	}
}

func TestServiceSaveAndDeleteControllerToggleEnabled(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if err := service.DeleteController(); err != nil || enabled.enabled || !enabled.set {
		t.Fatalf("DeleteController err=%v enabled=(%t,%t)", err, enabled.enabled, enabled.set)
	}

	notifiedEnabled := false

	service.SubscribeMutations(func() {
		notifiedEnabled, _ = enabled.PersistentRCIEnabled()
	})

	if _, err := service.SaveController(context.Background(), serviceTestControllerTester{}, "controller"); err != nil || !enabled.enabled {
		t.Fatalf("SaveController err=%v enabled=(%t,%t)", err, enabled.enabled, enabled.set)
	}

	if !notifiedEnabled {
		t.Fatal("SaveController notified before enabling the persistent session")
	}

	unsetService := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: &testEnabledStore{}, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if _, err := unsetService.SaveController(context.Background(), serviceTestControllerTester{}, "controller"); err != nil || !unsetService.SessionPresent() {
		t.Fatalf("unset SaveController err=%v present=%t", err, unsetService.SessionPresent())
	}
}

func TestServiceTokenlessUnsetFlagIsDisabled(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: panicServiceStore{t: t}, EnabledStore: &testEnabledStore{}, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})

	if service.Enabled() || service.SessionPresent() {
		t.Fatal("unset tokenless flag should be disabled")
	}
}

func TestServiceSaveControllerFlagWriteFailureFailsClosed(t *testing.T) {
	enabled := &testEnabledStore{set: true, setErr: errors.New("state write failed")}
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if _, err := service.SaveController(context.Background(), serviceTestControllerTester{}, "controller"); err == nil || service.SessionPresent() {
		t.Fatalf("failed save err=%v present=%t", err, service.SessionPresent())
	}

	enabled.setErr = nil

	if _, err := service.SaveController(context.Background(), serviceTestControllerTester{}, "controller"); err != nil || !service.SessionPresent() {
		t.Fatalf("retry save err=%v present=%t", err, service.SessionPresent())
	}
}

func TestServiceDeleteControllerTokenlessSkipsTokenStore(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true}
	service := newTestService(t, ServiceConfig{Store: panicServiceStore{t: t}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeNone}})
	notifications := 0

	service.SubscribeMutations(func() { notifications++ })

	if err := service.DeleteController(); err != nil || enabled.enabled || service.SessionPresent() || notifications != 1 {
		t.Fatalf("err=%v enabled=%t present=%t notifications=%d", err, enabled.enabled, service.SessionPresent(), notifications)
	}
}

func TestServiceDeleteControllerTokenlessFlagWriteFailureRetry(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true, setErr: errors.New("state write failed")}
	manager := sessionmanager.New()

	manager.ApplyEnumeration([]enumeration.Member{{Identity: "node", MAC: "aa:bb:cc:dd:ee:01", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true}})

	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeNone}, Manager: manager})
	managerEpoch := manager.Epoch()
	notifications := 0

	service.SubscribeMutations(func() { notifications++ })

	if err := service.DeleteController(); err == nil || !service.SessionPresent() || manager.Epoch() != managerEpoch || notifications != 0 {
		t.Fatalf("first delete err=%v present=%t managerEpoch=%d notifications=%d", err, service.SessionPresent(), manager.Epoch(), notifications)
	}

	enabled.setErr = nil

	if err := service.DeleteController(); err != nil || service.SessionPresent() || manager.Epoch() != managerEpoch+1 || notifications != 1 {
		t.Fatalf("retry delete err=%v present=%t managerEpoch=%d notifications=%d", err, service.SessionPresent(), manager.Epoch(), notifications)
	}
}

func TestServiceDeleteControllerTokenFlagWriteFailureRetry(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	enabled := &testEnabledStore{enabled: true, set: true, setErr: errors.New("state write failed")}
	service := newTestService(t, ServiceConfig{Store: store, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})

	if err := service.DeleteController(); err == nil || store.document.Controller == nil || !service.SessionPresent() {
		t.Fatalf("first delete err=%v record=%#v present=%t", err, store.document.Controller, service.SessionPresent())
	}

	enabled.setErr = nil

	if err := service.DeleteController(); err != nil || store.document.Controller != nil || service.SessionPresent() {
		t.Fatalf("retry delete err=%v record=%#v present=%t", err, store.document.Controller, service.SessionPresent())
	}
}

func TestServiceDeleteControllerTokenDeleteFailureFailsClosed(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}, deleteErr: errors.New("token delete failed")}
	enabled := &testEnabledStore{enabled: true, set: true}
	service := newTestService(t, ServiceConfig{Store: store, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeToken}})
	notifications := 0

	service.SubscribeMutations(func() { notifications++ })

	if err := service.DeleteController(); err == nil || enabled.enabled || service.SessionPresent() || notifications != 1 {
		t.Fatalf("first delete err=%v enabled=%t present=%t notifications=%d", err, enabled.enabled, service.SessionPresent(), notifications)
	}

	store.deleteErr = nil

	if err := service.DeleteController(); err != nil || store.document.Controller != nil || notifications != 2 {
		t.Fatalf("retry delete err=%v record=%#v notifications=%d", err, store.document.Controller, notifications)
	}
}

type testServiceStore struct {
	document  model.Document
	deleteErr error
}

func (s *testServiceStore) State() model.StoreState { return model.StateOK }
func (s *testServiceStore) Snapshot() (model.Document, error) {
	if s.document.Controller == nil {
		return model.Document{}, nil
	}

	clone := *s.document.Controller

	return model.Document{Controller: &clone}, nil
}
func (s *testServiceStore) ReplaceController(record model.TokenRecord) error {
	s.document.Controller = &record

	return nil
}

func (s *testServiceStore) DeleteController() error {
	if s.deleteErr != nil {
		return s.deleteErr
	}

	s.document.Controller = nil

	return nil
}

type testEnabledStore struct {
	enabled bool
	set     bool
	setErr  error
}

func (s *testEnabledStore) PersistentRCIEnabled() (bool, bool) { return s.enabled, s.set }
func (s *testEnabledStore) SetPersistentRCIEnabled(enabled bool) error {
	if s.setErr != nil {
		return s.setErr
	}

	s.enabled = enabled
	s.set = true

	return nil
}

type testAuthModeSource struct{ mode AuthMode }

func (s testAuthModeSource) Mode() AuthMode                  { return s.mode }
func (s testAuthModeSource) Detect(context.Context) AuthMode { return s.mode }

type sequenceAuthModeSource struct {
	modes []AuthMode
	index int
}

func (s *sequenceAuthModeSource) Mode() AuthMode {
	if s.index == 0 {
		return AuthModeUnknown
	}

	return s.modes[s.index-1]
}
func (s *sequenceAuthModeSource) Detect(context.Context) AuthMode {
	if s.index < len(s.modes) {
		s.index++
	}

	return s.Mode()
}

type serviceTestTesterFunc func(context.Context, string) (ControllerVerdict, error)

func (f serviceTestTesterFunc) Test(ctx context.Context, token string) (ControllerVerdict, error) {
	return f(ctx, token)
}

type panicServiceStore struct{ t *testing.T }

func (s panicServiceStore) State() model.StoreState {
	s.t.Helper()
	s.t.Fatal("unexpected token store State call")

	return model.StateDecryptFailed
}
func (s panicServiceStore) Snapshot() (model.Document, error) {
	s.t.Helper()
	s.t.Fatal("unexpected token store Snapshot call")

	return model.Document{}, errors.New("unexpected token store Snapshot call")
}
func (s panicServiceStore) ReplaceController(model.TokenRecord) error {
	s.t.Helper()
	s.t.Fatal("unexpected token store ReplaceController call")

	return errors.New("unexpected token store ReplaceController call")
}
func (s panicServiceStore) DeleteController() error {
	s.t.Helper()
	s.t.Fatal("unexpected token store DeleteController call")

	return errors.New("unexpected token store DeleteController call")
}

type serviceTestControllerTester struct{}

func (serviceTestControllerTester) Test(context.Context, string) (ControllerVerdict, error) {
	return ControllerValid, nil
}

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func newTestService(t *testing.T, cfg ServiceConfig) *Service {
	t.Helper()

	service, err := NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}

	return service
}

func TestNewServiceRequiresStore(t *testing.T) {
	if _, err := NewService(ServiceConfig{}); err == nil {
		t.Fatal("NewService without store returned no error")
	}
}

func TestNewServiceRejectsInvalidControllerURL(t *testing.T) {
	for _, controllerURL := range []string{"ftp://192.0.2.1", "http://192.0.2.1/path"} {
		t.Run(controllerURL, func(t *testing.T) {
			if _, err := NewService(ServiceConfig{Store: &testServiceStore{}, ControllerURL: controllerURL}); err == nil {
				t.Fatalf("NewService accepted controller URL %q", controllerURL)
			}
		})
	}
}

func TestNewServiceUsesConfiguredControllerURLAndClient(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	requests := 0
	client := &http.Client{Transport: testRoundTripper(func(request *http.Request) (*http.Response, error) {
		requests++

		if request.URL.Host != "192.0.2.1:79" || !strings.HasPrefix(request.URL.Path, "/rci/") || request.Header.Get("X-Ndma-Tkn") != "controller" {
			t.Fatalf("request = %s token=%q", request.URL, request.Header.Get("X-Ndma-Tkn"))
		}

		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[]`))}, nil
	})}
	service := newTestService(t, ServiceConfig{Store: store, HTTPClient: client, ControllerURL: "http://192.0.2.1:79/"})

	if _, err := service.Do(context.Background(), proxy.Request{Target: "controller", Method: http.MethodGet, Path: "rci/show/version"}); err != nil {
		t.Fatal(err)
	}

	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestNewServiceWithoutHTTPClientUsesDefaults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/rci/show/version" || request.Header.Get("X-Ndma-Tkn") != "controller" {
			t.Errorf("request = %s token=%q", request.URL, request.Header.Get("X-Ndma-Tkn"))
		}

		writer.WriteHeader(http.StatusOK)

		_, _ = io.WriteString(writer, "default client works")
	}))

	defer server.Close()

	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	service := newTestService(t, ServiceConfig{Store: store, ControllerURL: server.URL})
	response, err := service.Do(context.Background(), proxy.Request{Target: "controller", Method: http.MethodGet, Path: "rci/show/version"})
	if err != nil || response.Status != http.StatusOK || string(response.Body) != "default client works" {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
}

func TestNewServiceEnumeratorBoundToService(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	var request *http.Request
	client := &http.Client{Transport: testRoundTripper(func(got *http.Request) (*http.Response, error) {
		request = got

		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[]`))}, nil
	})}
	service := newTestService(t, ServiceConfig{Store: store, HTTPClient: client, ControllerURL: "http://192.0.2.1:80"})

	if _, err := service.Targets(context.Background()); err != nil {
		t.Fatal(err)
	}

	if request == nil || request.URL.String() != "http://192.0.2.1:80/rci/" || request.Header.Get("X-Ndma-Tkn") != "controller" {
		t.Fatalf("enumeration request = %#v", request)
	}
}
