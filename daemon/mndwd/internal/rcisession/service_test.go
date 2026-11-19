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
	"sync"
	"testing"
	"time"

	rci "mndw.local/rci"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
	"mndwd/internal/rcisession/proxy"
	"mndwd/internal/rcisession/sessionmanager"
)

func TestServiceResolveUsesManagerClassification(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}
	manager := sessionmanager.New(sessionmanager.Options{})
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

func TestServiceInvalidateDoesNotInvalidateNewlySavedController(t *testing.T) {
	store := &controllerRaceStore{
		document:              model.Document{Controller: &model.TokenRecord{Token: "old", Support: model.SupportSupported}},
		firstSnapshotEntered:  make(chan struct{}),
		releaseFirstSnapshot:  make(chan struct{}),
		secondSnapshotEntered: make(chan struct{}),
		releaseSecondSnapshot: make(chan struct{}),
		newControllerWritten:  make(chan struct{}),
	}
	service := newTestService(t, ServiceConfig{Store: store})
	var releaseOnce sync.Once
	releaseSnapshots := func() {
		releaseOnce.Do(func() {
			store.releaseFirstSnapshotOnce()
			store.releaseSecondSnapshotOnce()
		})
	}

	defer releaseSnapshots()

	invalidated := make(chan struct{})

	go func() {
		service.InvalidateController(0)
		close(invalidated)
	}()

	select {
	case <-store.firstSnapshotEntered:
	case <-time.After(time.Second):
		t.Fatal("invalidation did not reach controller snapshot")
	}

	serialized := !service.controllerMu.TryLock()

	if !serialized {
		service.controllerMu.Unlock()
	}

	testerEntered := make(chan struct{})
	saveDone := make(chan error, 1)

	go func() {
		_, err := service.SaveController(context.Background(), serviceTestTesterFunc(func(context.Context, string) (ControllerVerdict, error) {
			close(testerEntered)

			return ControllerValid, nil
		}), "new")
		saveDone <- err
	}()

	select {
	case <-testerEntered:
	case <-time.After(time.Second):
		t.Fatal("save did not reach controller tester")
	}

	var saveErr error

	if serialized {
		store.releaseFirstSnapshotOnce()

		select {
		case <-invalidated:
		case <-time.After(time.Second):
			t.Fatal("controller invalidation did not finish")
		}

		select {
		case <-store.secondSnapshotEntered:
		case <-time.After(time.Second):
			t.Fatal("save did not reach controller snapshot after invalidation")
		}

		store.releaseSecondSnapshotOnce()
	} else {
		select {
		case <-store.secondSnapshotEntered:
		case <-time.After(time.Second):
			t.Fatal("save did not reach controller snapshot")
		}

		store.releaseSecondSnapshotOnce()

		select {
		case <-store.newControllerWritten:
		case <-time.After(time.Second):
			t.Fatal("save did not write the new controller")
		}
	}

	select {
	case saveErr = <-saveDone:
	case <-time.After(time.Second):
		t.Fatal("save controller did not finish")
	}

	if !serialized {
		store.releaseFirstSnapshotOnce()

		select {
		case <-invalidated:
		case <-time.After(time.Second):
			t.Fatal("controller invalidation did not finish")
		}
	}

	if saveErr != nil {
		t.Fatalf("save controller: %v", saveErr)
	}

	document, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}

	if document.Controller == nil || document.Controller.Token != "new" || document.Controller.Support != model.SupportSupported {
		t.Fatalf("controller after invalidate and save = %#v, want new supported token", document.Controller)
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
	notifications := make(chan struct{}, 1)

	service.SubscribeMutations(func() { notifications <- struct{}{} })

	for range 3 {
		service.DetectAuthMode(context.Background())
	}

	waitMutationNotification(t, notifications)
}

func TestSubscribeMutationsReceivesNotify(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}})
	notifications := make(chan struct{}, 1)

	service.SubscribeMutations(func() {
		_ = service.ControllerEpoch()
		notifications <- struct{}{}
	})

	if err := service.DeleteController(); err != nil {
		t.Fatal(err)
	}

	waitMutationNotification(t, notifications)
}

func TestSubscribeMutationsKeepsMultipleObservers(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller", Support: model.SupportSupported}}}})
	coordinatorNotifications := make(chan struct{}, 1)
	logPollerNotifications := make(chan struct{}, 1)

	service.SubscribeMutations(func() { coordinatorNotifications <- struct{}{} })
	service.SubscribeMutations(func() { logPollerNotifications <- struct{}{} })

	if err := service.DeleteController(); err != nil {
		t.Fatal(err)
	}

	waitMutationNotification(t, coordinatorNotifications)
	waitMutationNotification(t, logPollerNotifications)
}

func TestSubscribeMutationsUnsubscribeRemovesObserver(t *testing.T) {
	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}})
	notified := make(chan struct{}, 1)
	unsubscribe := service.SubscribeMutations(func() { notified <- struct{}{} })

	unsubscribe()
	unsubscribe()
	service.notifyMutation("after-unsubscribe")

	select {
	case <-notified:
		t.Fatal("unsubscribed observer received a mutation")
	default:
	}
}

func TestSubscribeMutationsDeliversInOrderBeforeReturningAndKeepsPanickingObserver(t *testing.T) {
	logOutput := &mutationLogOutput{writes: make(chan struct{}, 4)}
	service := newTestService(t, ServiceConfig{
		Store:  &testServiceStore{},
		Logger: slog.New(slog.NewTextHandler(logOutput, nil)),
	})
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseObserver := func() { releaseOnce.Do(func() { close(release) }) }

	defer releaseObserver()

	events := make(chan string, 6)
	var firstGate sync.Once

	service.SubscribeMutations(func() {
		events <- "panicking"

		panic("observer failed")
	})
	service.SubscribeMutations(func() { events <- "healthy" })
	service.SubscribeMutations(func() {
		events <- "gate"

		firstGate.Do(func() {
			close(started)
			<-release
		})
	})

	mutationDone := make(chan struct{})

	go func() {
		service.notifyMutation("test")
		close(mutationDone)
	}()

	select {
	case <-started:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("mutation observer did not start")
	}

	select {
	case <-mutationDone:
		t.Fatal("notifyMutation returned before its observers completed")
	case <-time.After(50 * time.Millisecond):
	}

	releaseObserver()

	select {
	case <-mutationDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("notifyMutation did not return after its observers completed")
	}

	for _, want := range []string{"panicking", "healthy", "gate"} {
		if got := <-events; got != want {
			t.Fatalf("first mutation observer = %q, want %q", got, want)
		}
	}

	service.notifyMutation("second")

	for index, want := range []string{"panicking", "healthy", "gate"} {
		select {
		case got := <-events:
			if got != want {
				t.Fatalf("second mutation observer %d = %q, want %q", index, got, want)
			}
		case <-time.After(250 * time.Millisecond):
			t.Fatalf("second mutation observer %d not delivered; logs=%s", index, logOutput.String())
		}
	}

	if got := strings.Count(logOutput.String(), "mutation observer panicked"); got != 2 {
		t.Fatalf("panic log count = %d, want 2; output=%s", got, logOutput.String())
	}
}

func waitMutationNotification(t *testing.T, notifications <-chan struct{}) {
	t.Helper()

	select {
	case <-notifications:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for mutation observer")
	}
}

func receiveMutationValue(t *testing.T, values <-chan bool) bool {
	t.Helper()

	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for mutation observer value")

		return false
	}
}

type mutationLogOutput struct {
	mu     sync.Mutex
	output bytes.Buffer
	writes chan struct{}
}

func (w *mutationLogOutput) Write(data []byte) (int, error) {
	w.mu.Lock()

	n, err := w.output.Write(data)

	w.mu.Unlock()

	w.writes <- struct{}{}

	return n, err
}

func (w *mutationLogOutput) String() string {
	w.mu.Lock()

	defer w.mu.Unlock()

	return w.output.String()
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

	notifiedEnabled := make(chan bool, 1)

	service.SubscribeMutations(func() {
		current, _ := enabled.PersistentRCIEnabled()
		notifiedEnabled <- current
	})

	if _, err := service.SaveController(context.Background(), serviceTestControllerTester{}, "controller"); err != nil || !enabled.enabled {
		t.Fatalf("SaveController err=%v enabled=(%t,%t)", err, enabled.enabled, enabled.set)
	}

	if !receiveMutationValue(t, notifiedEnabled) {
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
	notifications := make(chan struct{}, 2)

	service.SubscribeMutations(func() { notifications <- struct{}{} })

	if err := service.DeleteController(); err != nil || enabled.enabled || service.SessionPresent() {
		t.Fatalf("err=%v enabled=%t present=%t", err, enabled.enabled, service.SessionPresent())
	}

	waitMutationNotification(t, notifications)
}

func TestServiceDeleteControllerTokenlessFlagWriteFailureRetry(t *testing.T) {
	enabled := &testEnabledStore{enabled: true, set: true, setErr: errors.New("state write failed")}
	manager := sessionmanager.New(sessionmanager.Options{})

	manager.ApplyEnumeration([]enumeration.Member{{Identity: "node", MAC: "aa:bb:cc:dd:ee:01", FQDN: "node.keenetic.io", FQDNCertificateValid: true, AuthTokenCapable: true}})

	service := newTestService(t, ServiceConfig{Store: &testServiceStore{}, EnabledStore: enabled, AuthModeSource: testAuthModeSource{mode: AuthModeNone}, Manager: manager})
	managerEpoch := manager.Epoch()
	notifications := make(chan struct{}, 1)

	service.SubscribeMutations(func() { notifications <- struct{}{} })

	if err := service.DeleteController(); err == nil || !service.SessionPresent() || manager.Epoch() != managerEpoch {
		t.Fatalf("first delete err=%v present=%t managerEpoch=%d", err, service.SessionPresent(), manager.Epoch())
	}

	enabled.setErr = nil

	if err := service.DeleteController(); err != nil || service.SessionPresent() || manager.Epoch() != managerEpoch+1 {
		t.Fatalf("retry delete err=%v present=%t managerEpoch=%d", err, service.SessionPresent(), manager.Epoch())
	}

	waitMutationNotification(t, notifications)
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
	notifications := make(chan struct{}, 2)

	service.SubscribeMutations(func() { notifications <- struct{}{} })

	if err := service.DeleteController(); err == nil || enabled.enabled || service.SessionPresent() {
		t.Fatalf("first delete err=%v enabled=%t present=%t", err, enabled.enabled, service.SessionPresent())
	}

	waitMutationNotification(t, notifications)

	store.deleteErr = nil

	if err := service.DeleteController(); err != nil || store.document.Controller != nil {
		t.Fatalf("retry delete err=%v record=%#v", err, store.document.Controller)
	}

	waitMutationNotification(t, notifications)
}

type testServiceStore struct {
	document  model.Document
	deleteErr error
}

type controllerRaceStore struct {
	mu                     sync.Mutex
	document               model.Document
	snapshots              int
	firstSnapshotEntered   chan struct{}
	releaseFirstSnapshot   chan struct{}
	secondSnapshotEntered  chan struct{}
	releaseSecondSnapshot  chan struct{}
	newControllerWritten   chan struct{}
	firstReleaseOnce       sync.Once
	secondReleaseOnce      sync.Once
	newControllerWriteOnce sync.Once
}

func (s *controllerRaceStore) State() model.StoreState { return model.StateOK }
func (s *controllerRaceStore) Snapshot() (model.Document, error) {
	s.mu.Lock()

	s.snapshots++
	snapshotNumber := s.snapshots
	var document model.Document

	if s.document.Controller != nil {
		controller := *s.document.Controller
		document.Controller = &controller
	}

	s.mu.Unlock()

	switch snapshotNumber {
	case 1:
		close(s.firstSnapshotEntered)
		<-s.releaseFirstSnapshot
	case 2:
		close(s.secondSnapshotEntered)
		<-s.releaseSecondSnapshot
	}

	return document, nil
}

func (s *controllerRaceStore) ReplaceController(record model.TokenRecord) error {
	s.mu.Lock()

	s.document.Controller = &record

	s.mu.Unlock()

	if record.Token == "new" && record.Support == model.SupportSupported {
		s.newControllerWriteOnce.Do(func() { close(s.newControllerWritten) })
	}

	return nil
}

func (s *controllerRaceStore) DeleteController() error {
	s.mu.Lock()

	s.document.Controller = nil

	s.mu.Unlock()

	return nil
}

func (s *controllerRaceStore) releaseFirstSnapshotOnce() {
	s.firstReleaseOnce.Do(func() { close(s.releaseFirstSnapshot) })
}

func (s *controllerRaceStore) releaseSecondSnapshotOnce() {
	s.secondReleaseOnce.Do(func() { close(s.releaseSecondSnapshot) })
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

	if cfg.Logger == nil {
		cfg.Logger = serviceTestLogger()
	}

	service, err := NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}

	return service
}

func TestNewServiceRequiresStore(t *testing.T) {
	if _, err := NewService(ServiceConfig{Logger: serviceTestLogger()}); err == nil {
		t.Fatal("NewService without store returned no error")
	}
}

func TestNewServiceRejectsInvalidControllerURL(t *testing.T) {
	for _, controllerURL := range []string{"ftp://192.0.2.1", "http://192.0.2.1/path"} {
		t.Run(controllerURL, func(t *testing.T) {
			if _, err := NewService(ServiceConfig{Store: &testServiceStore{}, ControllerURL: controllerURL, Logger: serviceTestLogger()}); err == nil {
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
