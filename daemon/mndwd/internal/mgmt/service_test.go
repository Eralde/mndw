package mgmt

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mndwd/internal/initd"
)

type fakeServiceManager struct {
	listErr      error
	startFn      func(context.Context, string) (initd.ServiceEntry, error)
	setEnabledFn func(context.Context, string, bool) (initd.ServiceEntry, error)
	services     []initd.ServiceEntry
}

func (m *fakeServiceManager) List(context.Context) ([]initd.ServiceEntry, error) {
	return m.services, m.listErr
}
func (m *fakeServiceManager) Status(context.Context, string) (initd.ServiceEntry, error) {
	if len(m.services) == 0 {
		return initd.ServiceEntry{}, &initd.InvalidServiceError{Name: "missing"}
	}

	return m.services[0], nil
}
func (m *fakeServiceManager) Start(ctx context.Context, name string) (initd.ServiceEntry, error) {
	if m.startFn != nil {
		return m.startFn(ctx, name)
	}

	return initd.ServiceEntry{Name: name, Label: name, State: "running"}, nil
}
func (m *fakeServiceManager) Stop(context.Context, string) (initd.ServiceEntry, error) {
	return initd.ServiceEntry{}, nil
}
func (m *fakeServiceManager) Restart(context.Context, string) (initd.ServiceEntry, error) {
	return initd.ServiceEntry{}, nil
}
func (m *fakeServiceManager) SetEnabled(ctx context.Context, name string, enabled bool) (initd.ServiceEntry, error) {
	if m.setEnabledFn != nil {
		return m.setEnabledFn(ctx, name, enabled)
	}

	return initd.ServiceEntry{}, nil
}

func newServiceTestHandler(manager initd.Manager, timeout time.Duration) *Handler {
	return New(Config{ServiceActionRoot: context.Background(), ServiceActionTimeout: timeout, Runtime: passthroughRuntime{}}, nil, nil, manager, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestServiceListEmptyDirectoryResponse(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{services: []initd.ServiceEntry{}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mgmt/service/list", nil))

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"services":[]`) {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceListUnavailableResponse(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{listErr: initd.ErrServiceUnavailable}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mgmt/service/list", nil))

	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "SERVICE_UNAVAILABLE") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceActionIgnoresRequestCancellation(t *testing.T) {
	called := make(chan struct{})
	h := newServiceTestHandler(&fakeServiceManager{startFn: func(_ context.Context, name string) (initd.ServiceEntry, error) {
		close(called)

		return initd.ServiceEntry{Name: name, State: "running"}, nil
	}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	requestCtx, cancel := context.WithCancel(context.Background())

	cancel()

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/start", strings.NewReader(`{"name":"S99foo"}`)).WithContext(requestCtx))
	<-called

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceActionTimeoutResponse(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{startFn: func(ctx context.Context, _ string) (initd.ServiceEntry, error) {
		<-ctx.Done()

		return initd.ServiceEntry{}, ctx.Err()
	}}, 5*time.Millisecond)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/start", strings.NewReader(`{"name":"S99foo"}`)))

	if recorder.Code != http.StatusGatewayTimeout || !strings.Contains(recorder.Body.String(), "ACTION_TIMEOUT") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceActionMapsProtectedError(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{startFn: func(context.Context, string) (initd.ServiceEntry, error) {
		return initd.ServiceEntry{}, &initd.ProtectedServiceError{Name: "S70mndwd"}
	}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/start", strings.NewReader(`{"name":"S70mndwd"}`)))

	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "PROTECTED_SERVICE") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceSetEnabledResponse(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{setEnabledFn: func(_ context.Context, name string, enabled bool) (initd.ServiceEntry, error) {
		if name != "S99foo" || enabled {
			t.Fatalf("SetEnabled(%q, %v), want (S99foo, false)", name, enabled)
		}

		return initd.ServiceEntry{Name: "K99foo", EnabledAtBoot: false}, nil
	}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/set-enabled", strings.NewReader(`{"name":"S99foo","enabled":false}`)))

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"name":"K99foo"`) {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceSetEnabledMapsPinnedErrorToConflict(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{setEnabledFn: func(context.Context, string, bool) (initd.ServiceEntry, error) {
		return initd.ServiceEntry{}, &initd.EnabledPinnedError{Name: "S99foo"}
	}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/set-enabled", strings.NewReader(`{"name":"S99foo","enabled":false}`)))

	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "CONFLICT") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceSetEnabledMapsProtectedError(t *testing.T) {
	h := newServiceTestHandler(&fakeServiceManager{setEnabledFn: func(context.Context, string, bool) (initd.ServiceEntry, error) {
		return initd.ServiceEntry{}, &initd.ProtectedServiceError{Name: "S70mndwd"}
	}}, time.Second)
	mux := http.NewServeMux()

	h.Register(mux)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/service/set-enabled", strings.NewReader(`{"name":"S70mndwd","enabled":false}`)))

	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "PROTECTED_SERVICE") {
		t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
	}
}
