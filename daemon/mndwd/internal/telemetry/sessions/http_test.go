package sessions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"mndwd/internal/telemetry/journal"
)

func newSessionTestMux(t *testing.T) (*http.ServeMux, journal.StorageProvider, journal.BootID) {
	t.Helper()

	provider, boot := seedSessionJournal(t)
	mux := http.NewServeMux()

	RegisterRoutes(mux, NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits()), nil)

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

	lease, err := acquireReadLease(context.Background(), provider)
	if err != nil {
		t.Fatal(err)
	}
	stale := encodeCursor(cursor{
		boot:                boot,
		inventoryGeneration: generationOf(lease),
		nextSequence:        1,
		snapshotThrough:     durableThrough(lease) - 1,
	})
	_ = lease.close()

	if got := call("/api/mndw/telemetry/sessions/" + SessionID(boot) + "?after=" + stale); got.Code != http.StatusGone {
		t.Fatalf("stale cursor status=%d body=%s", got.Code, got.Body.String())
	}

	if got := call("/api/mndw/telemetry/sessions/" + SessionID(boot) + "?limit=1001"); got.Code != http.StatusBadRequest {
		t.Fatalf("oversized limit status=%d", got.Code)
	}

	if got := call("/api/mndw/telemetry/sessions?nope=1"); got.Code != http.StatusBadRequest {
		t.Fatalf("unknown query status=%d", got.Code)
	}
}

func TestSessionReadRoutePassesCursorAndLimit(t *testing.T) {
	reader := &stubSessionReader{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, reader, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet,
		"/api/mndw/telemetry/sessions/"+SessionID(journal.BootID{1})+"?limit=17&after=opaque-cursor",
		nil,
	))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if reader.gotAfter != "opaque-cursor" || reader.gotLimit != 17 {
		t.Fatalf("after=%q limit=%d", reader.gotAfter, reader.gotLimit)
	}
}

func TestSessionReadRouteFollowsNextCursor(t *testing.T) {
	provider, boot := seedSessionJournal(t)
	defer func() { _ = provider.Close(context.Background()) }()

	lease, err := provider.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	extra, err := journal.PrepareSample(journal.Sample{
		Boot:      boot,
		Series:    1,
		ElapsedMs: 1000,
		Values:    []journal.Value{{Known: true, V: 21}, {Known: true, V: 30}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lease.Result.Writer.Append(context.Background(), []journal.Record{extra}); err != nil {
		_ = lease.Close()
		t.Fatal(err)
	}
	if _, err := lease.Result.Writer.Sync(context.Background()); err != nil {
		_ = lease.Close()
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits()), nil)
	path := "/api/mndw/telemetry/sessions/" + SessionID(boot)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, httptest.NewRequest(http.MethodGet, path+"?limit=1", nil))
	if first.Code != http.StatusOK {
		t.Fatalf("first page status=%d body=%s", first.Code, first.Body.String())
	}

	var firstPage SessionPage
	if err := json.Unmarshal(first.Body.Bytes(), &firstPage); err != nil {
		t.Fatal(err)
	}
	if !firstPage.Truncated || firstPage.NextCursor == nil || len(firstPage.Samples) != 1 {
		t.Fatalf("first page=%+v", firstPage)
	}

	second := httptest.NewRecorder()
	query := url.Values{"limit": {"1"}, "after": {*firstPage.NextCursor}}
	mux.ServeHTTP(second, httptest.NewRequest(http.MethodGet, path+"?"+query.Encode(), nil))
	if second.Code != http.StatusOK {
		t.Fatalf("second page status=%d body=%s", second.Code, second.Body.String())
	}

	var secondPage SessionPage
	if err := json.Unmarshal(second.Body.Bytes(), &secondPage); err != nil {
		t.Fatal(err)
	}
	if len(secondPage.Samples) != 1 || secondPage.Samples[0].Sequence == firstPage.Samples[0].Sequence {
		t.Fatalf("second page=%+v first page=%+v", secondPage, firstPage)
	}
}

func TestSessionRoutesServeWithoutRRD(t *testing.T) {
	// Sessions read retained records only: they must work when no RRD file or
	// RRDtool binary exists.
	provider, boot := seedSessionJournal(t)

	defer func() { _ = provider.Close(context.Background()) }()

	mux := http.NewServeMux()

	RegisterRoutes(mux, NewReader(provider, func() Status { return Status{} }, journal.DefaultLimits()), nil)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry/sessions/"+SessionID(boot)+"?limit=10", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSessionRoutesUnavailableWhenReaderMissing(t *testing.T) {
	mux := http.NewServeMux()

	RegisterRoutes(mux, &stubSessionReader{err: ErrSessionUnavailable}, nil)

	recorder := httptest.NewRecorder()

	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/mndw/telemetry/sessions/"+SessionID(journal.BootID{1}), nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", recorder.Code)
	}
}

type stubSessionReader struct {
	err      error
	gotAfter string
	gotLimit int
}

func (s *stubSessionReader) List(context.Context) (SessionList, error) {
	return SessionList{}, s.err
}

func (s *stubSessionReader) Read(_ context.Context, _ string, after string, limit int) (SessionPage, error) {
	s.gotAfter = after
	s.gotLimit = limit
	return SessionPage{Samples: []SessionSample{}, TruncationReasons: []string{}}, s.err
}
