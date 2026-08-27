package rcisession

import (
	"context"
	"errors"
	"io"
	"net/http"
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
	service := NewService(store, nil)
	manager := sessionmanager.New()
	service.SetSessionManager(manager)
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
	service := NewService(store, nil)
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
	service := NewService(store, nil)
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

func TestServiceAuthURLCapturesTokenAndParsesRelayURL(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller-secret", Support: model.SupportSupported}}}
	service := NewService(store, nil)
	if err := service.SetControllerURL("http://192.0.2.1", true); err != nil {
		t.Fatal(err)
	}
	service.SetControllerClient(&http.Client{Transport: testRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/rci/" || request.Header.Get("X-Ndma-Tkn") != "controller-secret" {
			t.Fatalf("request = %s token=%q", request.URL.Path, request.Header.Get("X-Ndma-Tkn"))
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"mws":{"member":{"auth-url":{"url":"https://node.keenetic.io/auth?x-ndma-tkn=relay"}}}}]`))}, nil
	})})
	url, epoch, err := service.AuthURL(context.Background(), "node")
	if err != nil || url != "https://node.keenetic.io/auth?x-ndma-tkn=relay" || epoch != 0 {
		t.Fatalf("AuthURL() = %q, %d, %v", url, epoch, err)
	}
}

func TestServiceAuthURLPreservesUnauthorizedStatusForEpochInvalidation(t *testing.T) {
	store := &testServiceStore{document: model.Document{Controller: &model.TokenRecord{Token: "controller-secret", Support: model.SupportSupported}}}
	service := NewService(store, nil)
	service.SetControllerClient(&http.Client{Transport: testRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("secret"))}, nil
	})})
	_, _, err := service.AuthURL(context.Background(), "node")
	var httpError *rci.HTTPError
	if !errors.As(err, &httpError) || httpError.StatusCode != http.StatusUnauthorized {
		t.Fatalf("AuthURL() error = %v", err)
	}
}

type testServiceStore struct{ document model.Document }

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
func (s *testServiceStore) DeleteController() error { s.document.Controller = nil; return nil }

type serviceTestControllerTester struct{}

func (serviceTestControllerTester) Test(context.Context, string) (ControllerVerdict, error) {
	return ControllerValid, nil
}

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }
