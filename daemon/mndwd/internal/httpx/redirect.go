package httpx

import "net/http"

// NoRedirect prevents daemon HTTP clients from following redirects.
// The 3xx response is returned to the caller as-is.
func NoRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}
