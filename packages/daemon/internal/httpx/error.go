// Package httpx holds the daemon's HTTP plumbing: the structured error envelope
// (design §5.6) and the request-logging middleware. Everything mndwd serves goes
// through these helpers so responses stay uniform and greppable in the router log.
package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

// Stable machine-readable error codes (SCREAMING_SNAKE). Clients map these to typed
// errors / UI copy; the human-readable message is advisory only. Grow this list as
// later phases add handlers — never repurpose an existing code.
const (
	CodeUploadTooLarge   = "UPLOAD_TOO_LARGE"
	CodeInvalidZip       = "INVALID_ZIP"
	CodeManifestInvalid  = "MANIFEST_INVALID"
	CodeManifestMissing  = "MANIFEST_MISSING"
	CodeBadRequest       = "BAD_REQUEST"
	CodeNotFound         = "NOT_FOUND"
	CodeConflict         = "CONFLICT"
	CodeMethodNotAllowed = "METHOD_NOT_ALLOWED"
	CodeInternal         = "INTERNAL"

	// Phase 2b: dispatch, ws proxy, and the session gate. NOT_APPROVED / DISABLED /
	// ROUTE_NOT_FOUND are the codes the SDK backend client maps onto its typed errors
	// (packages/sdk/src/backend-client.ts) — never repurpose them.
	CodeRouteNotFound   = "ROUTE_NOT_FOUND"
	CodeNotApproved     = "NOT_APPROVED"
	CodeDisabled        = "DISABLED"
	CodeScriptFailed    = "SCRIPT_FAILED"
	CodeScriptTimeout   = "SCRIPT_TIMEOUT"
	CodeBodyTooLarge    = "BODY_TOO_LARGE"
	CodeTooManyRequests = "TOO_MANY_REQUESTS"
	CodeUnauthorized    = "UNAUTHORIZED"
	CodeBadGateway      = "BAD_GATEWAY"

	// Phase 2c: opkg dependency management and backend.daemon lifecycle.
	CodeOpkgFailed         = "OPKG_FAILED"
	CodeInvalidPackageName = "INVALID_PACKAGE_NAME"
	CodeDaemonFailed       = "DAEMON_FAILED"
)

// APIError is the single shape of every non-2xx response body. It also implements
// error so handlers can build one and return it up the stack.
type APIError struct {
	// Status is the HTTP status code to send; not part of the wire envelope.
	Status int `json:"-"`
	// Code is the stable machine key.
	Code string `json:"code"`
	// Message is a human sentence.
	Message string `json:"message"`
	// Detail is optional extra context (e.g. a validation issue list). Nil when absent.
	Detail any `json:"detail"`
}

// Error satisfies the error interface.
func (e *APIError) Error() string {
	return e.Code + ": " + e.Message
}

// NewError builds an APIError with the given status, code and message.
func NewError(status int, code, message string) *APIError {
	return &APIError{Status: status, Code: code, Message: message}
}

// WithDetail attaches a detail payload and returns the receiver for chaining.
func (e *APIError) WithDetail(detail any) *APIError {
	e.Detail = detail

	return e
}

// envelope is the wire wrapper: {"error": {...}}.
type envelope struct {
	Error *APIError `json:"error"`
}

// WriteError serializes err as the standard envelope with its status code. A nil
// logger is tolerated. 5xx codes are logged at error level, everything else at debug.
func WriteError(w http.ResponseWriter, logger *slog.Logger, err *APIError) {
	if logger != nil {
		level := slog.LevelDebug
		if err.Status >= http.StatusInternalServerError {
			level = slog.LevelError
		}

		logger.Log(context.Background(), level, "request error",
			"status", err.Status, "code", err.Code, "message", err.Message)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.Status)
	_ = json.NewEncoder(w).Encode(envelope{Error: err})
}

// WriteJSON writes a 2xx JSON body. Encoding failures are logged, not surfaced —
// headers are already committed by then.
func WriteJSON(w http.ResponseWriter, logger *slog.Logger, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(body); err != nil && logger != nil {
		logger.Error("failed to encode response body", "error", err)
	}
}
