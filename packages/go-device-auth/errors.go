package auth

// ErrorKind distinguishes authentication outcomes without exposing protocol
// material in error text.
type ErrorKind string

const (
	ErrorRejected    ErrorKind = "rejected"
	ErrorTransport   ErrorKind = "transport"
	ErrorTimeout     ErrorKind = "timeout"
	ErrorUnsupported ErrorKind = "unsupported"
	ErrorMalformed   ErrorKind = "malformed"
)

// AuthError is safe to return to callers and logs no credentials or proofs.
type AuthError struct {
	Kind ErrorKind
	Err  error
}

func (e *AuthError) Error() string { return "authentication failed: " + string(e.Kind) }
func (e *AuthError) Unwrap() error { return e.Err }
