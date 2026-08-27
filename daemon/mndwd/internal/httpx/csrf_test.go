package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCSRFPresent(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if CSRFPresent(r) {
		t.Fatal("CSRFPresent = true for missing header")
	}
	r.Header.Set("X-Mndw-Csrf", "1")
	if !CSRFPresent(r) {
		t.Fatal("CSRFPresent = false for header \"1\"")
	}
}

func TestRequireCSRFWritesForbiddenWhenMissing(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if RequireCSRF(w, nil, r) {
		t.Fatal("RequireCSRF = true when header missing")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
}

func TestRequireCSRFPassesWhenPresent(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Mndw-Csrf", "1")
	if !RequireCSRF(w, nil, r) {
		t.Fatal("RequireCSRF = false when header present")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want untouched 200", w.Code)
	}
}
