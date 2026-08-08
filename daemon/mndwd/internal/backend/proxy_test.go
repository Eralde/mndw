package backend

import (
	"net/http"
	"testing"
)

func TestServiceRequestHeadersUseAllowlist(t *testing.T) {
	request, err := http.NewRequest(http.MethodPost, "http://mndw/status?q=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", "secret")
	request.Header.Set("Authorization", "secret")
	request.Header.Set("X-Mndw-Csrf", "1")
	request.Header.Set("Content-Type", "application/json")
	filtered := filteredServiceHeaders(request.Header)
	if filtered.Get("Cookie") != "" || filtered.Get("Authorization") != "" || filtered.Get("X-Mndw-Csrf") != "" {
		t.Fatalf("sensitive headers survived: %#v", filtered)
	}
	if filtered.Get("Content-Type") != "application/json" {
		t.Fatalf("content type removed: %#v", filtered)
	}
}
