package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"mndwd/internal/telemetry/journal"
)

func newSessionTestMux(t *testing.T) (*http.ServeMux, journal.StorageProvider, journal.BootID) {
	t.Helper()
	provider, boot := seedSessionJournal(t)
	mux := http.NewServeMux()
	RegisterSessionRoutes(mux, NewSessionReader(provider, func() PipelineStatus { return PipelineStatus{} }, journal.DefaultLimits()), nil)
	return mux, provider, boot
}

func TestSessionRoutesRequireAuthenticationBoundary(t *testing.T) {
	mux, provider, _ := newSessionTestMux(t)
	defer func() { _ = provider.Close(context.Background()) }()

	// The route is mounted; the verifier middleware in front of it enforces
	// session auth outside this package.
	request := httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry/sessions", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control=%q", got)
	}

	var list SessionList
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Storage.Mode != string(journal.StatusReady) {
		t.Fatalf("storage=%+v", list.Storage)
	}
	if list.Sessions == nil {
		t.Fatal("sessions serialized as null")
	}
}

func TestSessionReadRouteStatusCodes(t *testing.T) {
	mux, provider, boot := newSessionTestMux(t)
	defer func() { _ = provider.Close(context.Background()) }()

	call := func(target string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		return recorder
	}

	ok := call("/api/mndw/telemetry/sessions/" + SessionID(boot))
	if ok.Code != http.StatusOK {
		t.Fatalf("read status=%d body=%s", ok.Code, ok.Body.String())
	}

	var page SessionPage
	if err := json.Unmarshal(ok.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Samples == nil || page.TruncationReasons == nil {
		t.Fatalf("collections serialized as null: %+v", page)
	}
	if len(page.Samples) != 1 {
		t.Fatalf("samples=%+v", page.Samples)
	}

	if got := call("/api/mndw/telemetry/sessions/" + SessionID(journal.BootID{9})); got.Code != http.StatusNotFound {
		t.Fatalf("unknown session status=%d", got.Code)
	}
	if got := call("/api/mndw/telemetry/sessions/" + SessionID(boot) + "?after=bad"); got.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor status=%d", got.Code)
	}
	if got := call("/api/mndw/telemetry/sessions/" + SessionID(boot) + "?limit=1001"); got.Code != http.StatusBadRequest {
		t.Fatalf("oversized limit status=%d", got.Code)
	}
	if got := call("/api/mndw/telemetry/sessions?nope=1"); got.Code != http.StatusBadRequest {
		t.Fatalf("unknown query status=%d", got.Code)
	}
}

func TestSessionRoutesServeWithoutRRD(t *testing.T) {
	// Sessions read retained records only: they must work when no RRD file or
	// RRDtool binary exists.
	provider, boot := seedSessionJournal(t)
	defer func() { _ = provider.Close(context.Background()) }()

	mux := http.NewServeMux()
	RegisterSessionRoutes(mux, NewSessionReader(provider, func() PipelineStatus { return PipelineStatus{} }, journal.DefaultLimits()), nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry/sessions/"+SessionID(boot)+"?limit=10", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSessionRoutesUnavailableWhenReaderMissing(t *testing.T) {
	mux := http.NewServeMux()
	RegisterSessionRoutes(mux, &stubSessionReader{err: ErrSessionUnavailable}, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry/sessions/"+SessionID(journal.BootID{1}), nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", recorder.Code)
	}
}

type stubSessionReader struct {
	err error
}

func (s *stubSessionReader) List(context.Context) (SessionList, error) {
	return SessionList{}, s.err
}

func (s *stubSessionReader) Read(context.Context, string, string, int) (SessionPage, error) {
	return SessionPage{}, s.err
}
