package access

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"mndwd/internal/state"
)

func testHandler(t *testing.T) (*state.Store, http.Handler) {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	New(store).Register(mux)
	return store, mux
}

func TestAccessRequiresCsrfAndPersists(t *testing.T) {
	store, handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/mndw/extender-access", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("GET without CSRF = %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodPut, "/api/mndw/extender-access", bytes.NewBufferString(`{"enabled":true}`))
	request.Header.Set("X-Mndw-Csrf", "1")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !store.Snapshot().ExtenderAccessEnabled {
		t.Fatalf("PUT = %d, state = %#v", recorder.Code, store.Snapshot())
	}
}

func TestAccessDefaultsFalseForOlderState(t *testing.T) {
	_, handler := testHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/mndw/extender-access", nil)
	request.Header.Set("X-Mndw-Csrf", "1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "{\"enabled\":false}\n" {
		t.Fatalf("GET = %d %q", recorder.Code, recorder.Body.String())
	}
}
