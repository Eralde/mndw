package httpx

import (
	"log/slog"
	"net/http"
)

// CSRFPresent reports whether the request carries the mndw CSRF header. It is the
// single source of truth for the header name/value.
func CSRFPresent(r *http.Request) bool {
	return r.Header.Get("X-Mndw-Csrf") == "1"
}

// RequireCSRF returns true when the CSRF header is present. Otherwise it writes a
// 403 CSRF error and returns false, so handlers can `if !RequireCSRF(...) { return }`.
func RequireCSRF(w http.ResponseWriter, logger *slog.Logger, r *http.Request) bool {
	if CSRFPresent(r) {
		return true
	}

	WriteError(w, logger, NewError(http.StatusForbidden, CodeCsrfRequired, "CSRF header required"))

	return false
}
