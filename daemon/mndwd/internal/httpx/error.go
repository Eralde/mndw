// Package httpx holds the daemon's HTTP plumbing: the structured error envelope
// and request-logging middleware. Everything mndwd serves goes through these
// helpers so responses stay uniform and greppable in the device log.
package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"mndw.local/contracts/protocol"
)

// Stable machine-readable error codes (SCREAMING_SNAKE). Clients map these to typed
// errors / UI copy; the human-readable message is advisory only. Grow this list as
// handlers are added — never repurpose an existing code.
const (
	CodeUploadTooLarge             = "UPLOAD_TOO_LARGE"
	CodeInvalidZip                 = "INVALID_ZIP"
	CodeManifestInvalid            = "MANIFEST_INVALID"
	CodeManifestMissing            = "MANIFEST_MISSING"
	CodeUnsupportedManifestVersion = "UNSUPPORTED_MANIFEST_VERSION"
	CodeBadRequest                 = "BAD_REQUEST"
	CodeNotFound                   = "NOT_FOUND"
	CodeConflict                   = "CONFLICT"
	CodeMethodNotAllowed           = "METHOD_NOT_ALLOWED"
	CodeInternal                   = "INTERNAL"

	// Backend route and session-gate errors. NOT_APPROVED / DISABLED /
	// ROUTE_NOT_FOUND are the codes the SDK backend client maps onto its typed errors
	// (frontend/sdk/src/backend-client.ts) — never repurpose them.
	CodeRouteNotFound           = "ROUTE_NOT_FOUND"
	CodeNotApproved             = "NOT_APPROVED"
	CodeDisabled                = "DISABLED"
	CodeScriptFailed            = "SCRIPT_FAILED"
	CodeScriptTimeout           = "SCRIPT_TIMEOUT"
	CodeBodyTooLarge            = "BODY_TOO_LARGE"
	CodeTooManyRequests         = "TOO_MANY_REQUESTS"
	CodeBackendBusy             = "BACKEND_BUSY"
	CodeServiceCapacityExceeded = "SERVICE_CAPACITY_EXCEEDED"
	CodeBackendBodyTooLarge     = "BACKEND_BODY_TOO_LARGE"
	CodeBackendOutputTooLarge   = "BACKEND_OUTPUT_TOO_LARGE"
	CodeBackendUnavailable      = "BACKEND_UNAVAILABLE"
	CodeBackendStarting         = "BACKEND_STARTING"
	CodeBackendMaintenance      = "BACKEND_MAINTENANCE"
	CodeBackendBlocked          = "BACKEND_BLOCKED"
	CodeBackendIncompatible     = "BACKEND_INCOMPATIBLE"
	CodeCsrfRequired            = "CSRF_REQUIRED"
	CodeUnauthorized            = "UNAUTHORIZED"
	CodeBadGateway              = "BAD_GATEWAY"

	// Explicit package management and backend lifecycle errors.
	CodeOpkgFailed                    = "OPKG_FAILED"
	CodeOpkgBusy                      = "OPKG_BUSY"
	CodeOpkgUnavailable               = "OPKG_UNAVAILABLE"
	CodeSelfUpdateNotAvailable        = "SELF_UPDATE_NOT_AVAILABLE"
	CodeSelfUpdateRollbackUnavailable = "SELF_UPDATE_ROLLBACK_UNAVAILABLE"
	CodeSelfUpdateFailed              = "SELF_UPDATE_FAILED"
	CodeInvalidPackageName            = "INVALID_PACKAGE_NAME"
	CodeProtectedPackage              = "PROTECTED_PACKAGE"
	CodeDependencyConflict            = "DEPENDENCY_CONFLICT"
	CodeInvalidServiceName            = "INVALID_SERVICE_NAME"
	CodeProtectedService              = "PROTECTED_SERVICE"
	CodeServiceUnavailable            = "SERVICE_UNAVAILABLE"
	CodeActionFailed                  = "ACTION_FAILED"
	CodeActionTimeout                 = "ACTION_TIMEOUT"
	CodeUnknown                       = "UNKNOWN"
	CodeDaemonFailed                  = "DAEMON_FAILED"
	CodeRCITokenInvalid               = "RCI_TOKEN_INVALID"
	CodeRCIFirmwareUnsupported        = "RCI_FIRMWARE_UNSUPPORTED"
	CodeRCIDeviceUnreachable          = "RCI_DEVICE_UNREACHABLE"
	CodeRCIAuthModeMismatch           = "RCI_AUTH_MODE_MISMATCH"
	CodeControllerSessionUnavailable  = "CONTROLLER_SESSION_UNAVAILABLE"
	CodeRCISocketStartFailed          = "RCI_SOCKET_START_FAILED"
)

// APIError is the single shape of every non-2xx response body. It also implements
// error so handlers can build one and return it up the stack.
type APIError struct {
	// Status is the HTTP status code to send; not part of the wire envelope.
	Status int `json:"-"`
	protocol.StructuredError
}

// Error satisfies the error interface.
func (e *APIError) Error() string {
	return e.Code + ": " + e.Message
}

// NewError builds an APIError with the given status, code and message.
func NewError(status int, code, message string) *APIError {
	return &APIError{
		Status: status,
		StructuredError: protocol.StructuredError{
			Code:    code,
			Message: message,
		},
	}
}

// WithDetail attaches a detail payload and returns the receiver for chaining.
func (e *APIError) WithDetail(detail any) *APIError {
	e.StructuredError.Detail = detail

	return e
}

// envelope is the wire wrapper: {"error": {...}}.
type envelope struct {
	Error protocol.StructuredError `json:"error"`
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

	_ = json.NewEncoder(w).Encode(envelope{Error: err.StructuredError})
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
